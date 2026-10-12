<p align="center"><img src="web/logo.svg" width="80" alt="GrafBridge"></p>
<h1 align="center">GrafBridge</h1>
<p align="center">From title to screen, without boundaries.<br>An Electron desktop app for vMix GT → EBU OGraf conversion.</p>

GrafBridge turns `.gtzip` titles into standalone `.ograf.zip` packages. Import your titles, select fonts, convert animations, review warnings and preview the result in a desktop window. Original files are read without modification. Everything runs locally; no account or cloud service is required.

## Download and install

Windows builds include an **installer** and a **portable executable**, with Python and Pillow embedded. You do not need to install Python or Node.js. Executables are currently unsigned.

Open GrafBridge, drop `.gtzip` files or click **Browse** to choose a titles folder. Select one title or the entire batch, then click **Convert to OGraf**. **Open previews** opens an application window with In / Next / Out controls, editable JSON data and ZIP downloads.

Results are saved in GrafBridge's application data folder (`%APPDATA%/grafbridge/build/` on Windows). Every conversion has its own folder, and completed conversions are restored when you reopen the app. Original titles are never overwritten.

## Fonts

**Barlow** is included with its OFL license. Other families need their font files in the selected **Font folder**:

- `Family-Regular.ttf` or `Family-Regular.otf` is required.
- `Family-Bold.ttf` or `Family-Bold.otf` is optional.
- Add `Family-LICENSE.txt` if available.

Replace spaces in family names with hyphens in filenames, for example `Example-Sans-Regular.ttf` for **Example Sans**. GrafBridge checks the selected titles before conversion and lists missing font families and expected filenames. Choose the correct folder and scan again to enable conversion. Conversion does not grant redistribution rights to the original fonts or artwork.

## Supported formats and limits

Nodes: Layer, Image, TextBlock and Rectangle. Animations: Fade, Hidden, None, ImageSequence, Reveal and Fly. Image sizing: Normal, Stretch, Centered and TopRight. Unknown types and effects are rejected explicitly. After Effects `.mogrt` projects are not converted. Rendering adaptations are documented in each package's `conversion.json`.

Uploads support up to 256 MiB per title. Each output package is limited to 32 MiB compressed, 128 MiB uncompressed and 512 resources. The preview helps you inspect rendering; it does not measure the frame rate of a final video output.

An original demo title is included in `examples/GrafBridge.gtzip`.

## Development

Requirements: Python 3.11 or newer and Node.js 24.

```powershell
python -m venv .venv
& .venv/Scripts/python.exe -m pip install -r requirements.txt
npm ci
npm start
```

On Windows, `start.bat` prepares dependencies and launches Electron. On Linux and macOS, use `.venv/bin/python` instead. Automated distributions currently target Windows x64; other platforms can run from source.

Electron starts a local backend on a random loopback port. Native dialogs select folders, and previews open in isolated windows without Node.js access. `npm run start:web` also runs the UI in a browser for development.

```powershell
& .venv/Scripts/python.exe source/test-convert-vmix-gt.py
& .venv/Scripts/python.exe source/test-app.py
node --test source/build-paths.test.cjs
```

CI runs these tests on Windows and Linux. Junction tests are skipped when the Windows volume does not support them.

## Build and release

```powershell
& .venv/Scripts/python.exe -m pip install -r requirements-build.txt
& .venv/Scripts/python.exe scripts/build-backend.py
& .venv/Scripts/python.exe scripts/test-embedded.py build/backend/grafbridge-backend.exe
npm run dist:win
```

Outputs are written to `build/releases/`. The backend is a self-contained executable, including Python's standard library, fonts and web assets. It does not depend on an adjacent `_internal` folder. Every conversion starts with a fresh PyInstaller environment.

The **Release desktop** workflow tests the code, verifies a relocated standalone backend and two conversion subprocesses, builds the installer and portable version, checks desktop startup and writes SHA-256 checksums. Manual runs upload build artifacts without publishing a release.

To publish a release, update `package.json` and its lockfile, commit, then push a matching version tag. The workflow checks tag/version agreement before publishing binaries to GitHub Releases.

```sh
git tag v0.1.1
git push origin v0.1.1
```

## Command-line tools

```powershell
& .venv/Scripts/python.exe source/convert-vmix-gt.py 'D:/Titles' build/converted --fonts 'D:/Fonts'
& .venv/Scripts/python.exe source/verify-packages.py build/converted
```

Output and cache folders must be distinct subdirectories of `build/`, outside the source folder. `--title TITLE.gtzip` converts a single title. `--workers` accepts 1–16. The package verifier checks ZIP hashes and every generated resource without executing graphic code.

Official EBU schema validation requires Internet access and optional dependencies:

```sh
npm ci --prefix schema-validation --ignore-scripts
node source/validate-manifests.cjs build/converted
```

The optional [OGraf Studio adapter](docs/studio.md) adds editable sources for an external Studio 0.21.0 checkout. GrafBridge does not require Studio.
