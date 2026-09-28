"""Private, bounded FFmpeg service. Only the Worker binding can reach this port."""
import json, math, os, re, shutil, subprocess, tempfile, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

JOBS = {}
LOCK = threading.Lock()
MAX_BYTES = 500 * 1024 * 1024
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Redirect refused')

def command(args, timeout=90):
    p = subprocess.run(args, capture_output=True, timeout=timeout)
    if p.returncode:
        raise ValueError('Media processing failed')
    return p.stdout

def export_settings(job, payload):
    width,height=payload['width'],payload['height']
    if [width,height] not in [[720,1280],[1080,1920],[720,720],[1080,1080],[1280,720],[1920,1080],[720,900],[1080,1350]]:
        raise ValueError('Invalid dimensions')
    ass=os.path.join(job['dir'],'captions.ass')
    with open(ass,'w',encoding='utf-8') as f: f.write(payload['ass'])
    if payload.get('fit')=='cover':
        scale=f'scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}'
    else:
        scale=f'scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black'
    return width,height,scale,ass,os.path.join(job['dir'],'result.mp4')

def download(url, path, origin):
    parsed = urlparse(url)
    if f'{parsed.scheme}://{parsed.netloc}' != origin or not re.fullmatch(r'/api/media-inputs/[a-f0-9-]+/[0-9]+', parsed.path):
        raise ValueError('Invalid input')
    with urllib.request.build_opener(NoRedirect).open(url, timeout=90) as response, open(path, 'wb') as out:
        total = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk: break
            total += len(chunk)
            if total > MAX_BYTES: raise ValueError('File too large')
            out.write(chunk)

def probe(path):
    return json.loads(command(['ffprobe','-v','error','-protocol_whitelist','file,pipe','-show_format','-show_streams','-of','json',path]))

def number(value, low, high):
    value = float(value)
    if not math.isfinite(value) or value < low or value > high: raise ValueError('Invalid number')
    return value

def music_gain(music, length, music_duration):
    """FFmpeg volume expression for the same envelope as shared/timeline.ts musicGain (fades, ducking)."""
    start = number(music['start'], -3600, 3600)
    begin, end = max(0.0, start), min(length, start + music_duration)
    gain = f'{number(music["volume"], 0, 1):.4f}'
    if music.get('fade'):
        gain += f'*clip(min((t-{begin:.3f})/1,({end:.3f}-t)/1.5),0,1)'
    ranges = music.get('ranges') or []
    if music.get('duck') and ranges:
        if len(ranges) > 2000: raise ValueError('Too many ranges')
        # Merged speech ranges are at least 0.6 s apart, so their 0.3 s ramps never overlap and can be summed.
        terms = '+'.join(f'clip(min((t-{number(a, 0, 700) - 0.3:.3f})/0.3,({number(b, 0, 700) + 0.3:.3f}-t)/0.3),0,1)' for a, b in ranges)
        gain += f'*(1-0.7*clip({terms},0,1))'
    return gain

def timeline(job, payload, origin, width, height, scale, ass, output):
    """Joins scenes (video + approved voice each) with cuts, adds music under the whole video and burns captions.
    Each scene holds its first frame for the lead-in and its last frame for the end hold."""
    t = payload['timeline']
    # Tasks queued before multi-scene projects describe one scene with top-level fields.
    scenes = t['scenes'] if 'scenes' in t else [t]
    if not 1 <= len(scenes) <= 20: raise ValueError('Invalid scenes')
    urls = payload.get('urls') or []
    has_music = bool(t.get('music'))
    if len(urls) != 2 * len(scenes) + (1 if has_music else 0): raise ValueError('Invalid inputs')
    files = []
    for i, url in enumerate(urls):
        path = os.path.join(job['dir'], f'input{i}')
        download(url, path, origin); files.append(path)
    graph, video_labels, voice_labels, total = [], '', '', 0.0
    for i, scene in enumerate(scenes):
        speech_start, tail = number(scene['speech_start'], 0, 10), number(scene['tail'], 0, 10)
        voice_volume, speech = number(scene['voice_volume'], 0, 1), number(scene['speech_duration'], 0.1, 600)
        length = round(speech_start + speech + tail, 3)
        total += length
        info = probe(files[2 * i])
        video = next((s for s in info.get('streams',[]) if s.get('codec_type')=='video'), None)
        if not video or video.get('width',0)>4096 or video.get('height',0)>4096: raise ValueError('Invalid video')
        # Like the browser export: use the video's own soundtrack (lip sync) only when it matches the approved voice.
        soundtrack = next((s for s in info['streams'] if s.get('codec_type')=='audio'), None)
        duration = float((soundtrack or {}).get('duration') or info.get('format',{}).get('duration') or 0)
        voice = f'{2 * i}:a:0' if soundtrack and abs(duration - speech) <= 0.25 else f'{2 * i + 1}:a:0'
        ms = int(round(speech_start * 1000))
        graph.append(f'[{2 * i}:v:0]tpad=start_duration={speech_start:.3f}:start_mode=clone:stop_duration={length + 1:.3f}:stop_mode=clone,'
                     f'trim=duration={length:.3f},setpts=PTS-STARTPTS,fps=30,{scale},setsar=1,format=yuv420p[v{i}]')
        graph.append(f'[{voice}]aformat=sample_rates=48000:channel_layouts=stereo,volume={voice_volume:.4f},adelay=delays={ms}:all=1,'
                     f'apad,atrim=duration={length:.3f},asetpts=PTS-STARTPTS[a{i}]')
        video_labels += f'[v{i}]'; voice_labels += f'[a{i}]'
    total = round(total, 3)
    if total > 600: raise ValueError('Video too long')
    graph.append(f'{video_labels}concat=n={len(scenes)}:v=1:a=0,ass={ass}[v]')
    graph.append(f'{voice_labels}concat=n={len(scenes)}:v=0:a=1[voice]')
    audio = '[voice]'
    if has_music:
        m = len(files) - 1
        music_info = probe(files[m])
        music_duration = float(music_info.get('format',{}).get('duration') or 0)
        if not any(s.get('codec_type')=='audio' for s in music_info.get('streams',[])) or music_duration <= 0: raise ValueError('Invalid music')
        start = number(t['music']['start'], -3600, 3600)
        place = f'adelay=delays={int(round(start * 1000))}:all=1' if start >= 0 else f'atrim=start={-start:.3f},asetpts=PTS-STARTPTS'
        graph.append(f"[{m}:a:0]aformat=sample_rates=48000:channel_layouts=stereo,{place},apad,atrim=duration={total:.3f},"
                     f"volume='{music_gain(t['music'], total, music_duration)}':eval=frame[music]")
        graph.append('[voice][music]amix=inputs=2:duration=first:normalize=0[mix]')
        audio = '[mix]'
    command(['ffmpeg','-nostdin','-v','error','-threads','1','-protocol_whitelist','file,pipe',*sum((['-i', f] for f in files), []),
             '-filter_complex',';'.join(graph),'-map','[v]','-map',audio,'-filter_threads','1','-r','30','-c:v','libx264','-preset','veryfast',
             '-crf','23','-maxrate','4M','-bufsize','8M','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-t',f'{total:.3f}',
             '-movflags','+faststart',output],timeout=3000)
    return total

def process(job, payload):
    try:
        origin = os.environ.get('SOURCE_ORIGIN', 'https://rechbg.com')
        source = os.path.join(job['dir'], 'source')
        if payload['operation'] == 'timeline':
            width, height, scale, ass, output = export_settings(job, payload)
            length = timeline(job, payload, origin, width, height, scale, ass, output)
            if os.path.getsize(output)>400*1024*1024: raise ValueError('Output too large')
            job.update(status='completed',duration=length,file=output)
            return
        download(payload['url'], source, origin)
        data = json.loads(command(['ffprobe','-v','error','-protocol_whitelist','file,pipe','-show_format','-show_streams','-of','json',source]))
        duration = float(data.get('format',{}).get('duration',0))
        video = next((s for s in data.get('streams',[]) if s.get('codec_type')=='video'),None)
        if not math.isfinite(duration) or duration <= 0 or duration > 600 or not video:
            raise ValueError('Video must be 0–600 seconds')
        if video.get('width',0)>4096 or video.get('height',0)>4096 or video.get('width',0)*video.get('height',0)>9000000:
            raise ValueError('Source resolution too large')
        formats=set(data['format'].get('format_name','').split(','))
        if not formats.intersection({'mov','mp4','matroska','webm'}): raise ValueError('Unsupported video container')
        if payload['operation']=='inspect':
            if not any(s.get('codec_type')=='audio' for s in data['streams']): raise ValueError('Video has no audio')
            job.update(status='completed',duration=duration)
            return
        width, height, scale, ass, output = export_settings(job, payload)
        command(['ffmpeg','-nostdin','-v','error','-threads','1','-protocol_whitelist','file,pipe','-i',source,'-map','0:v:0','-map','0:a:0?',
                 '-vf',scale+f',setsar=1,ass={ass}', '-filter_threads','1','-r','30','-c:v','libx264','-preset','veryfast','-crf','23',
                 '-maxrate','4M','-bufsize','8M','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-t','600','-movflags','+faststart',output],timeout=1500)
        if os.path.getsize(output)>400*1024*1024: raise ValueError('Output too large')
        job.update(status='completed',duration=duration,file=output)
    except Exception:
        job.update(status='failed',error='MEDIA_PROCESSING_FAILED')
    finally:
        job['finished']=time.time()
        for name in os.listdir(job['dir']):
            if name == 'source' or name.startswith('input'): os.remove(os.path.join(job['dir'], name))

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def respond(self,status,body):
        data=json.dumps(body).encode(); self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_POST(self):
        if self.path!='/jobs': return self.respond(404,{})
        size=int(self.headers.get('Content-Length','0'))
        if size<=0 or size>2*1024*1024:return self.respond(413,{})
        payload=json.loads(self.rfile.read(size));id=payload.get('id','')
        if not re.fullmatch(r'[a-f0-9-]{36}',id) or payload.get('operation') not in ('inspect','export','timeline'):return self.respond(400,{})
        with LOCK:
            for key,old in list(JOBS.items()):
                if old.get('finished',time.time())<time.time()-1800:
                    shutil.rmtree(old['dir'],ignore_errors=True);del JOBS[key]
            if id in JOBS:return self.respond(200,{'status':JOBS[id]['status']})
            if any(j['status']=='running' for j in JOBS.values()):return self.respond(429,{'status':'busy'})
            job={'status':'running','dir':tempfile.mkdtemp(prefix='rech-')};JOBS[id]=job
            threading.Thread(target=process,args=(job,payload),daemon=True).start()
        return self.respond(202,{'status':'running'})
    def do_GET(self):
        parts=self.path.split('/');job=JOBS.get(parts[2]) if len(parts)>=3 and parts[1]=='jobs' else None
        if not job:return self.respond(404,{})
        if len(parts)==4 and parts[3]=='file' and job.get('file'):
            size=os.path.getsize(job['file']);self.send_response(200);self.send_header('Content-Type','video/mp4');self.send_header('Content-Length',str(size));self.end_headers()
            with open(job['file'],'rb') as f: shutil.copyfileobj(f,self.wfile,1024*1024)
            return
        return self.respond(200,{k:job[k] for k in ('status','duration','error') if k in job})
    def do_DELETE(self):
        id=self.path.rsplit('/',1)[-1]
        with LOCK:
            job=JOBS.get(id)
            if job and job['status']!='running':shutil.rmtree(job['dir'],ignore_errors=True);del JOBS[id]
        return self.respond(200,{})

if __name__=='__main__': ThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()
