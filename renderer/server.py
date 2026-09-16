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

def process(job, payload):
    try:
        parsed = urlparse(payload['url'])
        origin = os.environ.get('SOURCE_ORIGIN', 'https://rechbg.com')
        if f'{parsed.scheme}://{parsed.netloc}' != origin or not re.fullmatch(r'/api/media-inputs/[a-f0-9-]+/[0-9]+', parsed.path):
            raise ValueError('Invalid input')
        source = os.path.join(job['dir'], 'source')
        with urllib.request.build_opener(NoRedirect).open(payload['url'], timeout=90) as response, open(source, 'wb') as out:
            total = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk: break
                total += len(chunk)
                if total > MAX_BYTES: raise ValueError('File too large')
                out.write(chunk)
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
        width,height=payload['width'],payload['height']
        if [width,height] not in [[720,1280],[1080,1920],[720,720],[1080,1080],[1280,720],[1920,1080],[720,900],[1080,1350]]:
            raise ValueError('Invalid dimensions')
        ass=os.path.join(job['dir'],'captions.ass')
        with open(ass,'w',encoding='utf-8') as f: f.write(payload['ass'])
        if payload.get('fit')=='cover':
            scale=f'scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}'
        else:
            scale=f'scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black'
        output=os.path.join(job['dir'],'result.mp4')
        command(['ffmpeg','-nostdin','-v','error','-threads','1','-protocol_whitelist','file,pipe','-i',source,'-map','0:v:0','-map','0:a:0?',
                 '-vf',scale+f',setsar=1,ass={ass}', '-filter_threads','1','-r','30','-c:v','libx264','-preset','veryfast','-crf','23',
                 '-maxrate','4M','-bufsize','8M','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-t','600','-movflags','+faststart',output],timeout=1500)
        if os.path.getsize(output)>400*1024*1024: raise ValueError('Output too large')
        job.update(status='completed',duration=duration,file=output)
    except Exception:
        job.update(status='failed',error='MEDIA_PROCESSING_FAILED')
    finally:
        job['finished']=time.time()
        source=os.path.join(job['dir'],'source')
        if os.path.exists(source): os.remove(source)

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def respond(self,status,body):
        data=json.dumps(body).encode(); self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_POST(self):
        if self.path!='/jobs': return self.respond(404,{})
        size=int(self.headers.get('Content-Length','0'))
        if size<=0 or size>2*1024*1024:return self.respond(413,{})
        payload=json.loads(self.rfile.read(size));id=payload.get('id','')
        if not re.fullmatch(r'[a-f0-9-]{36}',id) or payload.get('operation') not in ('inspect','export'):return self.respond(400,{})
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
