"""HTTP tests covering local access, uploads, conversion and isolated output."""
from io import BytesIO
import json
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid
import zipfile

from PIL import Image
import app


class AppTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request(self, path, data=None, token=True, raw=None):
        headers = {'X-GrafBridge-Token': app.TOKEN} if token else {}
        body = raw if raw is not None else json.dumps(data).encode() if data is not None else None
        return urlopen(Request(self.origin + path, data=body, headers=headers), timeout=10)

    def test_local_access_and_no_repository_exposure(self):
        with self.request('/') as response:
            html = response.read().decode()
            self.assertIn(app.TOKEN, html)
            self.assertNotIn('__TOKEN__', html)
        for path in ['/../README.md', '/source/app.py', '/build/uploads/anything']:
            with self.assertRaises(HTTPError) as context:
                self.request(path)
            self.assertEqual(context.exception.code, 404)
        with self.assertRaises(HTTPError) as context:
            self.request('/api/scan', {'source': str(app.ROOT)}, token=False)
        self.assertEqual(context.exception.code, 403)
        request = Request(self.origin + '/', headers={'Host': 'untrusted.example'})
        with self.assertRaises(HTTPError) as context:
            urlopen(request)
        self.assertEqual(context.exception.code, 403)

    def test_upload_path_rejected(self):
        for name in ['../test.gtzip', 'C:test.gtzip', 'image.png']:
            with self.assertRaises(HTTPError) as context:
                self.request(f'/api/upload?batch={uuid.uuid4().hex}&name={name}', raw=b'fake')
            self.assertEqual(context.exception.code, 400)

    def test_upload_convert_preview_and_download(self):
        bitmap = BytesIO()
        Image.new('RGBA', (100, 100), 'green').save(bitmap, 'PNG')
        archive_bytes = BytesIO()
        with zipfile.ZipFile(archive_bytes, 'w') as archive:
            archive.writestr('document.xml', '<Composition Width="320" Height="180"><Image Name="LOGO" /></Composition>')
            archive.writestr('resources.xml', '<Resources/>')
            archive.writestr('thumbnail.png', bitmap.getvalue())
        batch = uuid.uuid4().hex
        upload_directory = app.BUILD / 'uploads' / batch
        self.addCleanup(shutil.rmtree, upload_directory, True)
        with self.request(f'/api/upload?batch={batch}&name=DEMO.GTZIP', raw=archive_bytes.getvalue()) as response:
            upload = json.load(response)
        self.assertEqual(upload['titles'][0]['name'], 'DEMO.GTZIP')
        with self.request('/api/convert', {'source': upload['source']}) as response:
            identifier = json.load(response)['id']
        self.addCleanup(shutil.rmtree, app.BUILD / 'jobs' / identifier, True)
        for _ in range(150):
            with self.request('/api/jobs') as response:
                job = next(job for job in json.load(response) if job['id'] == identifier)
            if job['status'] in {'done', 'error'}:
                break
            time.sleep(.1)
        self.assertEqual(job['status'], 'done', job.get('log'))
        with self.request(job['preview']) as response:
            self.assertIn('GrafBridge', response.read().decode())
        package = job['report']['templates'][0]['package']
        with self.request(f'/build/jobs/{identifier}/{package}') as response:
            with zipfile.ZipFile(BytesIO(response.read())) as archive:
                manifest = json.loads(archive.read('demo.ograf.json'))
                self.assertEqual(manifest['id'], 'com.grafbridge.gt.demo')
        from importlib.util import spec_from_file_location, module_from_spec
        spec = spec_from_file_location('verify_packages', app.ROOT / 'source/verify-packages.py')
        verifier = module_from_spec(spec)
        spec.loader.exec_module(verifier)
        self.assertTrue(verifier.verify(app.BUILD / 'jobs' / identifier)[0]['verified'])
        with (app.BUILD / 'jobs' / identifier / package).open('ab') as file:
            file.write(b'tampered')
        with self.assertRaises(ValueError):
            verifier.verify(app.BUILD / 'jobs' / identifier)


if __name__ == '__main__':
    unittest.main()
