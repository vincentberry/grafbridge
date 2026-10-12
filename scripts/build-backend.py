"""Build the local conversion engine with its fonts and web assets."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile',
           '--name', 'grafbridge-backend', '--distpath', str(root / 'build/backend'),
           '--workpath', str(root / 'build/pyinstaller'), '--specpath', str(root / 'build'),
           '--hidden-import', 'PIL.Image', '--hidden-import', 'PIL._webp']
for entry in ['web', 'fonts', 'source/convert-vmix-gt.py', 'source/gt-runtime.mjs', 'source/preview.html']:
    destination = 'source' if entry.startswith('source/') else entry
    command += ['--add-data', f'{root / entry}:{destination}']
command += [str(root / 'source/app.py')]
subprocess.run(command, cwd=root, check=True)
