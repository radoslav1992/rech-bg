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

if __name__ == '__main__': unittest.main()
