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

if __name__ == '__main__': unittest.main()
