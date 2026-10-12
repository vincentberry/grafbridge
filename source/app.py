"""GrafBridge local UI. Python + Pillow, no parent application required."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
from urllib.parse import parse_qs, unquote, urlsplit
import uuid
import webbrowser

ROOT = Path(sys._MEIPASS) if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent.parent
BUILD = Path(os.environ.get('GRAFBRIDGE_DATA_ROOT', str(ROOT))) / "build"
WEB = ROOT / "web"
TOKEN = secrets.token_urlsafe(32)
JOBS = {}
LOCK = threading.Lock()
POOL = ThreadPoolExecutor(max_workers=1)
MAX_UPLOAD = 256 * 1024 * 1024


def font_requirements(source, fonts, title=''):
    """Inspect text families without converting assets or executing title code."""
    import zipfile
    import xml.etree.ElementTree as ET
    directory = Path(source)
    folder = Path(fonts) if fonts else ROOT / 'fonts'
    required = set()
    available = titles(source)
    if title and title not in {item['name'] for item in available}:
        raise ValueError('Title not found in the source folder.')
    files = [directory / title] if title else [directory / item['name'] for item in available]
    for file in files:
        with zipfile.ZipFile(file) as archive:
            raw = archive.read('document.xml')
            document = ET.fromstring(raw.decode('utf-16' if raw[:2] in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig'))
        required.update(node.get('FontFamily', 'Barlow') for node in document.iter('TextBlock'))
    missing = []
    for family in sorted(required - {'Barlow'}):
        stem = family.replace(' ', '-')
        if any(c in stem for c in '/\\:') or stem in {'', '.', '..'}:
            raise ValueError(f'Invalid font family: {family}')
        expected = [f'{stem}-Regular.ttf', f'{stem}-Regular.otf']
        if not any((folder / name).is_file() for name in expected):
            missing.append({'family': family, 'files': expected})
    return {'required': sorted(required), 'missing': missing}


def titles(directory):
    directory = Path(directory).expanduser().resolve()
    if not directory.is_dir():
        raise ValueError("Source folder not found.")
    return [{"name": p.name, "bytes": p.stat().st_size} for p in sorted(directory.iterdir())
            if p.is_file() and p.suffix.lower() == ".gtzip"]


def run_job(identifier, source, fonts, title):
    output = BUILD / "jobs" / identifier
    command = [sys.executable, str(ROOT / "source/convert-vmix-gt.py"), source, str(output),
               "--fonts", fonts or str(ROOT / "fonts")]
    if getattr(sys, 'frozen', False):
        command = [sys.executable, '--convert', *command[2:]]
    if title:
        command += ["--title", title]
    try:
        with LOCK:
            JOBS[identifier]["status"] = "running"
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, encoding="utf-8", errors="replace",
                                   env=os.environ | {"PYTHONIOENCODING": "utf-8", "PYINSTALLER_RESET_ENVIRONMENT": "1"})
        for line in process.stdout:
            with LOCK:
                JOBS[identifier]["log"] += line
        process.stdout.close()
        if process.wait() != 0:
            raise ValueError("Conversion failed. Check the log for title or font errors.")
        report = json.loads((output / "conversion-report.json").read_text(encoding="utf-8"))
        with LOCK:
            JOBS[identifier].update(status="done", report=report,
                                    preview=f"/build/jobs/{identifier}/index.html")
    except Exception as error:
        with LOCK:
            JOBS[identifier].update(status="error", error=str(error))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def valid_host(self):
        return self.headers.get("Host") in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}

    def respond(self, value, status=200):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.valid_host():
            return self.send_error(403)
        route = unquote(urlsplit(self.path).path)
        if route == "/api/jobs":
            with LOCK:
                return self.respond(list(JOBS.values()))
        if route in {"/", "/index.html"}:
            body = (WEB / "index.html").read_text(encoding="utf-8").replace("__TOKEN__", TOKEN).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        if route.startswith("/build/jobs/"):
            target = (BUILD / route.removeprefix('/build/')).resolve()
            allowed = (BUILD / "jobs").resolve()
            if not target.is_relative_to(allowed) or not target.is_file():
                return self.send_error(404)
            if target.name == 'index.html':
                body = (ROOT / 'source/preview.html').read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                return self.wfile.write(body)
            # Serve only generated files; never list directories or expose the repository.
            self.path = "/" + target.relative_to(BUILD).as_posix()
            self.directory = str(BUILD)
        else:
            target = (WEB / route.lstrip("/")).resolve()
            if not target.is_relative_to(WEB.resolve()) or not target.is_file():
                return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        if not self.valid_host() or self.headers.get("X-GrafBridge-Token") != TOKEN:
            return self.respond({"error": "Unauthorized local request."}, 403)
        try:
            route = urlsplit(self.path)
            length = int(self.headers.get("Content-Length", 0))
            limit = MAX_UPLOAD if route.path == "/api/upload" else 16384
            if not 0 < length <= limit:
                return self.respond({"error": "File too large or empty request (maximum 256 MiB per title)."}, 413)
            if route.path == "/api/upload":
                query = parse_qs(route.query)
                batch, name = query["batch"][0], query["name"][0]
                if len(batch) != 32 or any(c not in "0123456789abcdef" for c in batch):
                    raise ValueError("Invalid batch.")
                if Path(name).name != name or any(c in name for c in '/\\:') or not name.lower().endswith('.gtzip'):
                    raise ValueError("Select a .gtzip file.")
                directory = BUILD / "uploads" / batch
                directory.mkdir(parents=True, exist_ok=True)
                with (directory / name).open('xb') as file:
                    remaining = length
                    while remaining:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError("Incomplete upload.")
                        file.write(chunk)
                        remaining -= len(chunk)
                return self.respond({"source": str(directory), "titles": titles(directory)})
            data = json.loads(self.rfile.read(length))
            if route.path == '/api/shutdown':
                self.respond({'shutdown': True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if route.path == "/api/scan":
                available = titles(data["source"])
                return self.respond({"titles": available, "fonts": font_requirements(data['source'], data.get('fonts', ''), data.get('title', ''))})
            if route.path == "/api/convert":
                source = str(Path(data["source"]).expanduser().resolve())
                available = titles(source)
                if not available:
                    raise ValueError("No .gtzip files in this folder.")
                title = data.get("title", "")
                if title and title not in {item["name"] for item in available}:
                    raise ValueError("Title not found in the source folder.")
                requirements = font_requirements(source, data.get('fonts', ''), title)
                if requirements['missing']:
                    names = ', '.join(item['family'] for item in requirements['missing'])
                    return self.respond({'error': f'Missing fonts: {names}. Select a font folder containing the required Regular .ttf or .otf files, then scan again.', 'fonts': requirements}, 422)
                identifier = uuid.uuid4().hex
                with LOCK:
                    if any(job["status"] in {"queued", "running"} for job in JOBS.values()):
                        return self.respond({"error": "A conversion is already running."}, 409)
                    JOBS[identifier] = {"id": identifier, "status": "queued", "log": "", "name": title or f"Batch of {len(available)} titles"}
                POOL.submit(run_job, identifier, source, data.get("fonts", ""), title)
                return self.respond({"id": identifier}, 202)
            return self.respond({"error": "Unknown route."}, 404)
        except Exception as error:
            return self.respond({"error": str(error)}, 400)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    for report in sorted((BUILD / "jobs").glob("*/conversion-report.json")):
        identifier = report.parent.name
        try:
            JOBS[identifier] = {"id": identifier, "name": "Saved conversion", "status": "done", "log": "",
                                "report": json.loads(report.read_text(encoding='utf-8')),
                                "preview": f"/build/jobs/{identifier}/index.html"}
        except (OSError, ValueError):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    origin = f'http://127.0.0.1:{server.server_port}'
    print(f'GrafBridge : {origin}', flush=True)
    if not args.no_browser:
        webbrowser.open(origin)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        POOL.shutdown(wait=True)


if __name__ == '__main__':
    if getattr(sys, 'frozen', False) and sys.argv[1:2] == ['--convert']:
        import importlib.util
        spec = importlib.util.spec_from_file_location('convert_gt', ROOT / 'source/convert-vmix-gt.py')
        converter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(converter)
        converter.main(sys.argv[2:])
    else:
        main()
