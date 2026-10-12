$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.11 ou plus récent est requis.' }
}
& .venv/Scripts/python.exe -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Installation des dépendances impossible.' }
if (-not (Test-Path -LiteralPath 'node_modules/electron/dist/electron.exe')) {
    npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Installation des dépendances Electron impossible.' }
}
npm.cmd start
