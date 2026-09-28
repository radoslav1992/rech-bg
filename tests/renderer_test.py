"""Run with python3 tests/renderer_test.py; requires local ffmpeg/ffprobe."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('renderer', root / 'renderer/server.py')
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)

class RendererTest(unittest.TestCase):
    def test_burns_cyrillic_and_preserves_audio_without_external_network(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.mp4'
            subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','color=c=green:s=320x180:d=1',
                            '-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-threads','1','-c:a','aac',str(source)],check=True)
            ass = '[Script Info]\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,Bold,BorderStyle,Outline,Alignment\nStyle: Default,Noto Sans,40,&H00FFFFFF,&H00000000,-1,1,3,2\n[Events]\nFormat: Layer,Start,End,Style,Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,Здравей свят!\n'
            class Opener:
                def open(self,*args,**kwargs): return source.open('rb')
            for operation in ['inspect','export']:
                work = Path(directory) / operation
                work.mkdir()
                job = {'dir':str(work),'status':'running'}
                payload = {'url':'https://rechbg.com/api/media-inputs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/0',
                           'operation':operation,'width':720,'height':1280,'ass':ass,'fit':'contain'}
                with patch.object(renderer.urllib.request,'build_opener',return_value=Opener()):
                    renderer.process(job,payload)
                self.assertEqual(job['status'],'completed',job)
                self.assertFalse((work/'source').exists())
                if operation == 'export':
                    streams = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',job['file']]))['streams']
                    self.assertTrue(any(s['codec_type']=='audio' for s in streams))
                    self.assertTrue(any(s.get('width')==720 and s.get('height')==1280 for s in streams))
    def test_rejects_foreign_input_before_network_access(self):
        with tempfile.TemporaryDirectory() as directory:
            job={'dir':directory,'status':'running'}
            with patch.object(renderer.urllib.request,'build_opener') as network:
                renderer.process(job,{'url':'https://attacker.invalid/video','operation':'inspect'})
                network.assert_not_called()
            self.assertEqual(job['status'],'failed')

    def test_timeline_adds_lead_in_hold_and_ducked_music(self):
        with tempfile.TemporaryDirectory() as directory:
            d = Path(directory)
            def make(name, *args):
                subprocess.run(['ffmpeg','-nostdin','-v','error',*args,str(d/name)],check=True)
            make('video.mp4','-f','lavfi','-i','color=c=blue:s=320x180:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-threads','1','-c:a','aac')
            make('voice.wav','-f','lavfi','-i','sine=frequency=330:duration=1')
            make('music.wav','-f','lavfi','-i','sine=frequency=220:duration=3')
            files = [d/'video.mp4', d/'voice.wav', d/'music.wav']
            class Opener:
                def open(self, url, *args, **kwargs): return files[int(url.rsplit('/',1)[1])].open('rb')
            base = 'https://rechbg.com/api/media-inputs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/'
            ass = '[Script Info]\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\n[Events]\nFormat: Layer,Start,End,Style,Text\n'
            def run(timeline, urls=3):
                work = d / f'job{len(list(d.iterdir()))}'; work.mkdir()
                job = {'dir': str(work), 'status': 'running'}
                payload = {'operation': 'timeline', 'url': base + '0', 'urls': [base + str(i) for i in range(urls)], 'width': 720, 'height': 1280,
                           'ass': ass, 'fit': 'contain', 'timeline': timeline}
                with patch.object(renderer.urllib.request, 'build_opener', return_value=Opener()):
                    renderer.process(job, payload)
                self.assertFalse(any(p.name.startswith('input') for p in work.iterdir()))
                return job
            music = {'start': -0.5, 'volume': 0.35, 'duck': True, 'fade': True, 'ranges': [[0.5, 1.5]]}
            job = run({'speech_start': 0.5, 'tail': 0.5, 'voice_volume': 1, 'speech_duration': 1.0, 'music': music})
            self.assertEqual(job['status'], 'completed', job)
            self.assertAlmostEqual(job['duration'], 2.0, places=2)
            info = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-show_streams','-of','json',job['file']]))
            self.assertAlmostEqual(float(info['format']['duration']), 2.0, delta=0.15)
            self.assertTrue(any(s['codec_type']=='audio' for s in info['streams']))
            self.assertTrue(any(s.get('width')==720 and s.get('height')==1280 for s in info['streams']))
            # Without music, only the video and the approved voice are needed.
            self.assertEqual(run({'speech_start': 0, 'tail': 0, 'voice_volume': 0.5, 'speech_duration': 1.0, 'music': None}, urls=2)['status'], 'completed')
            # Values outside the allowed ranges, or text smuggled into numbers, fail before FFmpeg runs.
            self.assertEqual(run({'speech_start': 11, 'tail': 0, 'voice_volume': 1, 'speech_duration': 1.0, 'music': None}, urls=2)['status'], 'failed')
            self.assertEqual(run({'speech_start': 0, 'tail': 0, 'voice_volume': 1, 'speech_duration': 1.0, 'music': {**music, 'volume': "1':eval=frame[x]"}})['status'], 'failed')

    def test_timeline_joins_scenes_with_cuts_and_music_across_them(self):
        with tempfile.TemporaryDirectory() as directory:
            d = Path(directory)
            def make(name, *args):
                subprocess.run(['ffmpeg','-nostdin','-v','error',*args,str(d/name)],check=True)
            # Two scenes of different shapes and lengths; the frame size comes from the payload.
            make('v0.mp4','-f','lavfi','-i','color=c=blue:s=320x180:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-threads','1','-c:a','aac')
            make('a0.wav','-f','lavfi','-i','sine=frequency=330:duration=1')
            make('v1.mp4','-f','lavfi','-i','color=c=red:s=180x320:d=2','-c:v','libx264','-threads','1')
            make('a1.wav','-f','lavfi','-i','sine=frequency=550:duration=2')
            make('music.wav','-f','lavfi','-i','sine=frequency=220:duration=10')
            files = [d/'v0.mp4', d/'a0.wav', d/'v1.mp4', d/'a1.wav', d/'music.wav']
            class Opener:
                def open(self, url, *args, **kwargs): return files[int(url.rsplit('/',1)[1])].open('rb')
            base = 'https://rechbg.com/api/media-inputs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/'
            ass = '[Script Info]\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\n[Events]\nFormat: Layer,Start,End,Style,Text\n'
            def run(urls, scenes, music):
                work = d / f'job{len(list(d.iterdir()))}'; work.mkdir()
                job = {'dir': str(work), 'status': 'running'}
                payload = {'operation': 'timeline', 'url': base + '0', 'urls': [base + str(i) for i in urls], 'width': 720, 'height': 1280,
                           'ass': ass, 'fit': 'cover', 'timeline': {'scenes': scenes, 'music': music}}
                with patch.object(renderer.urllib.request, 'build_opener', return_value=Opener()):
                    renderer.process(job, payload)
                return job
            scenes = [{'speech_start': 0.5, 'tail': 0, 'voice_volume': 1, 'speech_duration': 1.0},
                      {'speech_start': 0, 'tail': 0.5, 'voice_volume': 0.8, 'speech_duration': 2.0}]
            music = {'start': 0, 'volume': 0.3, 'duck': True, 'fade': True, 'ranges': [[0.5, 1.5], [1.5, 3.5]]}
            job = run(range(5), scenes, music)
            self.assertEqual(job['status'], 'completed', job)
            self.assertAlmostEqual(job['duration'], 4.0, places=2)
            info = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-show_streams','-of','json',job['file']]))
            self.assertAlmostEqual(float(info['format']['duration']), 4.0, delta=0.15)
            self.assertTrue(any(s['codec_type']=='audio' for s in info['streams']))
            self.assertTrue(any(s.get('width')==720 and s.get('height')==1280 for s in info['streams']))
            # The number of inputs must match the scenes (video + voice each, plus music).
            self.assertEqual(run(range(4), scenes, music)['status'], 'failed')

    def test_timeline_layers_backgrounds_broll_and_overlays(self):
        with tempfile.TemporaryDirectory() as directory:
            d = Path(directory)
            def make(name, *args):
                subprocess.run(['ffmpeg','-nostdin','-v','error',*args,str(d/name)],check=True)
            make('v0.mp4','-f','lavfi','-i','color=c=blue:s=320x180:d=1','-c:v','libx264','-threads','1')
            make('a0.wav','-f','lavfi','-i','sine=frequency=330:duration=1')
            make('v1.mp4','-f','lavfi','-i','color=c=yellow:s=200x200:d=1','-c:v','libx264','-threads','1')
            make('a1.wav','-f','lavfi','-i','sine=frequency=440:duration=1')
            make('bg.png','-f','lavfi','-i','color=c=0x00ff00:s=100x100','-frames:v','1')
            make('still.png','-f','lavfi','-i','color=c=magenta:s=90x160','-frames:v','1')
            make('clip.mp4','-f','lavfi','-i','color=c=cyan:s=320x180:d=2','-c:v','libx264','-threads','1')
            make('logo.png','-f','lavfi','-i','color=c=white:s=64x64','-frames:v','1')
            files = [d/'v0.mp4', d/'a0.wav', d/'v1.mp4', d/'a1.wav', d/'bg.png', d/'still.png', d/'clip.mp4', d/'logo.png']
            class Opener:
                def open(self, url, *args, **kwargs): return files[int(url.rsplit('/',1)[1])].open('rb')
            base = 'https://rechbg.com/api/media-inputs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/'
            ass = ('[Script Info]\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\n\n[V4+ Styles]\n'
                   'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
                   'Style: TB,Noto Sans,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,8,0,5,0,0,0,1\n\n'
                   '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
                   'Dialogue: 0,0:00:00.00,0:00:02.00,TB,,0,0,0,,{\\an2\\pos(360,1216)\\fs60}Заглавие\n')
            work = d / 'job'; work.mkdir()
            job = {'dir': str(work), 'status': 'running'}
            payload = {'operation': 'timeline', 'url': base + '0', 'urls': [base + str(i) for i in range(len(files))], 'width': 720, 'height': 1280,
                       'ass': ass, 'fit': 'contain', 'timeline': {'music': None, 'scenes': [
                           {'speech_start': 0, 'tail': 0, 'voice_volume': 1, 'speech_duration': 1.0, 'background': {'color': '#ff0000'}},
                           {'speech_start': 0, 'tail': 0, 'voice_volume': 1, 'speech_duration': 1.0, 'background': {'input': 4}},
                       ], 'layers': [
                           {'kind': 'broll', 'input': 5, 'start': 0.2, 'end': 0.45, 'trim': 0, 'still': True},
                           {'kind': 'broll', 'input': 6, 'start': 1.2, 'end': 1.5, 'trim': 0.5, 'still': False},
                           {'kind': 'image', 'input': 7, 'start': 0, 'end': 2, 'anchor': [0, 0], 'width': 0.2, 'opacity': 1},
                       ]}}
            with patch.object(renderer.urllib.request, 'build_opener', return_value=Opener()):
                renderer.process(job, payload)
            self.assertEqual(job['status'], 'completed', job)
            self.assertAlmostEqual(job['duration'], 2.0, places=2)
            def pixel(t, x, y):
                raw = subprocess.check_output(['ffmpeg','-nostdin','-v','error','-ss',str(t),'-i',job['file'],'-frames:v','1',
                                               '-vf',f'format=rgb24,crop=1:1:{x}:{y}','-f','rawvideo','-pix_fmt','rgb24','-'])
                return tuple(raw[:3])
            def near(c, want): return all(abs(a - b) < 60 for a, b in zip(c, want))
            self.assertTrue(near(pixel(0.1, 360, 300), (255, 0, 0)), 'colour background around the scene 1 video')
            self.assertTrue(near(pixel(0.8, 360, 640), (0, 0, 255)), 'scene 1 video')
            self.assertTrue(near(pixel(0.3, 360, 640), (255, 0, 255)), 'still B-roll fills the frame')
            self.assertTrue(near(pixel(1.35, 360, 640), (0, 255, 255)), 'video B-roll')
            self.assertTrue(near(pixel(1.7, 360, 150), (0, 255, 0)), 'image background around the scene 2 video (square video spans y 280-1000)')
            self.assertTrue(near(pixel(1.7, 360, 640), (255, 255, 0)), 'scene 2 video')
            self.assertTrue(near(pixel(0.8, 100, 100), (255, 255, 255)), 'logo overlay at the top left')
            self.assertTrue(near(pixel(0.8, 360, 1221), (0, 0, 0)), 'text box at the bottom (8 px border below the text)')
            self.assertTrue(near(pixel(0.8, 360, 1250), (255, 0, 0)), 'below the text box the background shows')
            # Layer inputs must point at layer media, not at the scenes' own video/voice.
            work2 = d / 'bad'; work2.mkdir(); bad = {'dir': str(work2), 'status': 'running'}
            payload['timeline']['layers'] = [{'kind': 'image', 'input': 0, 'start': 0, 'end': 1, 'anchor': [0, 0], 'width': 0.2, 'opacity': 1}]
            with patch.object(renderer.urllib.request, 'build_opener', return_value=Opener()):
                renderer.process(bad, payload)
            self.assertEqual(bad['status'], 'failed')

    def test_timeline_intro_still_and_outro_clip(self):
        with tempfile.TemporaryDirectory() as directory:
            d = Path(directory)
            def make(name, *args):
                subprocess.run(['ffmpeg','-nostdin','-v','error',*args,str(d/name)],check=True)
            make('v0.mp4','-f','lavfi','-i','color=c=blue:s=320x180:d=1','-c:v','libx264','-threads','1')
            make('a0.wav','-f','lavfi','-i','sine=frequency=330:duration=1')
            make('intro.png','-f','lavfi','-i','color=c=magenta:s=100x100','-frames:v','1')
            make('outro.mp4','-f','lavfi','-i','color=c=cyan:s=320x180:d=3','-f','lavfi','-i','sine=frequency=880:duration=3','-c:v','libx264','-threads','1','-c:a','aac')
            files = [d/'v0.mp4', d/'a0.wav', d/'intro.png', d/'outro.mp4']
            class Opener:
                def open(self, url, *args, **kwargs): return files[int(url.rsplit('/',1)[1])].open('rb')
            base = 'https://rechbg.com/api/media-inputs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/'
            work = d / 'job'; work.mkdir()
            job = {'dir': str(work), 'status': 'running'}
            payload = {'operation': 'timeline', 'url': base + '0', 'urls': [base + str(i) for i in range(4)], 'width': 720, 'height': 1280,
                       'ass': '[Script Info]\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\n[Events]\nFormat: Layer,Start,End,Style,Text\n', 'fit': 'contain', 'timeline': {
                           'music': None, 'layers': [],
                           'scenes': [{'speech_start': 0, 'tail': 0, 'voice_volume': 1, 'speech_duration': 1.0, 'background': None}],
                           'intro': {'input': 2, 'seconds': 2, 'still': True},
                           'outro': {'input': 3, 'seconds': 1.5, 'still': False}}}
            with patch.object(renderer.urllib.request, 'build_opener', return_value=Opener()):
                renderer.process(job, payload)
            self.assertEqual(job['status'], 'completed', job)
            self.assertAlmostEqual(job['duration'], 4.5, places=2)
            info = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-show_streams','-of','json',job['file']]))
            self.assertAlmostEqual(float(info['format']['duration']), 4.5, delta=0.15)
            def pixel(t, x=360, y=640):
                raw = subprocess.check_output(['ffmpeg','-nostdin','-v','error','-ss',str(t),'-i',job['file'],'-frames:v','1',
                                               '-vf',f'format=rgb24,crop=1:1:{x}:{y}','-f','rawvideo','-pix_fmt','rgb24','-'])
                return tuple(raw[:3])
            def near(c, want): return all(abs(a - b) < 60 for a, b in zip(c, want))
            self.assertTrue(near(pixel(1.0), (255, 0, 255)), 'intro image fills the frame')
            self.assertTrue(near(pixel(2.5), (0, 0, 255)), 'the scene follows the intro')
            self.assertTrue(near(pixel(3.8), (0, 255, 255)), 'outro clip, cut to its seconds')

if __name__ == '__main__': unittest.main()
