"""Test a relocated self-contained backend, including its conversion subprocess."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parent.parent
backend = Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix='GrafBridge embedded test ') as directory:
    isolated = Path(directory)
    executable = isolated / backend.name
    shutil.copy2(backend, executable)
    # No _internal directory is copied. The backend must contain its entire runtime.
    errors = (isolated / 'backend-errors.log').open('w', encoding='utf-8')
    process = subprocess.Popen([str(executable), '--port', '0', '--no-browser'],
                               stdout=subprocess.PIPE, stderr=errors, text=True,
                               env=os.environ | {'GRAFBRIDGE_DATA_ROOT': str(isolated), 'PYINSTALLER_RESET_ENVIRONMENT': '1'})
    try:
        line = process.stdout.readline()
        match = re.search(r'http://127\.0\.0\.1:\d+', line)
        if not match:
            raise RuntimeError('Embedded backend failed to start: ' + (isolated / 'backend-errors.log').read_text(encoding='utf-8'))
        origin = match[0]
        with urlopen(origin) as response:
            html = response.read().decode()
        token = re.search(r'name="grafbridge-token" content="([^"]+)"', html)[1]
        def post(route, data):
            request = Request(origin + route, data=json.dumps(data).encode(), headers={'X-GrafBridge-Token': token})
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        for _ in range(2):
            job_id = post('/api/convert', {'source': str(root / 'examples')})['id']
            for attempt in range(300):
                with urlopen(origin + '/api/jobs', timeout=10) as response:
                    job = next(item for item in json.load(response) if item['id'] == job_id)
                if job['status'] in {'done', 'error'}:
                    break
                time.sleep(.1)
            if job['status'] != 'done':
                raise RuntimeError(job.get('log') or 'Embedded conversion timed out.')
            subprocess.run([sys.executable, str(root / 'source/verify-packages.py'), str(isolated / 'build/jobs' / job_id)], check=True)
        print('Relocated embedded backend: startup and two subprocess conversions OK.')
        post('/api/shutdown', {})
        process.wait(timeout=30)
    finally:
        if process.poll() is None:
            if sys.platform == 'win32':
                subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
            else:
                process.terminate()
            process.wait(timeout=15)
        process.stdout.close()
        errors.close()
