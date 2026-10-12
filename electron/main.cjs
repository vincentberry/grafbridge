const { app, BrowserWindow, dialog, ipcMain, Menu, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let backend, origin, mainWindow, backendToken, quitting = false, shutdownComplete = false;

function backendCommand() {
  if (app.isPackaged) return [path.join(process.resourcesPath, 'backend', process.platform === 'win32' ? 'grafbridge-backend.exe' : 'grafbridge-backend'), []];
  const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return [fs.existsSync(python) ? python : process.platform === 'win32' ? 'python' : 'python3', [path.join(root, 'source/app.py')]];
}

function startBackend() {
  const [command, args] = backendCommand();
  return new Promise((resolve, reject) => {
    let text = '', errors = '', ready = false;
    const timeout = setTimeout(() => reject(new Error('The conversion engine did not respond.')), 30000);
    backend = spawn(command, [...args, '--port', '0', '--no-browser'], {
      cwd: app.isPackaged ? process.resourcesPath : root,
      windowsHide: true,
      env: { ...process.env, GRAFBRIDGE_DATA_ROOT: app.getPath('userData'), PYTHONIOENCODING: 'utf-8', PYINSTALLER_RESET_ENVIRONMENT: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    backend.stdout.on('data', chunk => {
      if (ready) return;
      text += chunk.toString();
      const match = text.match(/GrafBridge : (http:\/\/127\.0\.0\.1:\d+)/);
      if (match && !ready) { ready = true; clearTimeout(timeout); resolve(match[1]); }
    });
    backend.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4000); });
    backend.once('error', error => { clearTimeout(timeout); reject(error); });
    backend.once('exit', code => {
      clearTimeout(timeout);
      if (!ready) reject(new Error(errors || `The engine stopped (${code}). Install the Python dependencies when running from source.`));
      else if (!quitting) { dialog.showErrorBox('GrafBridge', 'The conversion engine stopped. Please restart GrafBridge.'); app.quit(); }
    });
  });
}

function createWindow(url, preview = false) {
  const window = new BrowserWindow({
    width: preview ? 1250 : 1380, height: 940, minWidth: 780, minHeight: 640,
    title: preview ? 'GrafBridge — Preview' : 'GrafBridge', backgroundColor: '#f5f6f3',
    icon: path.join(root, 'web/icon.png'), show: false, autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
      ...(preview ? {} : { preload: path.join(__dirname, 'preload.cjs') }) }
  });
  window.webContents.on('will-navigate', (event, destination) => {
    if (new URL(destination).origin !== origin) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url: destination }) => {
    const target = new URL(destination);
    if (target.origin === origin && target.pathname.startsWith('/build/jobs/')) createWindow(destination, true);
    return { action: 'deny' };
  });
  window.once('ready-to-show', () => window.show());
  window.loadURL(url).catch(error => dialog.showErrorBox('GrafBridge', error.message));
  return window;
}

if (process.env.GRAFBRIDGE_SMOKE_TEST === '1') app.setPath('userData', path.join(app.getPath('temp'), 'grafbridge-smoke-' + process.pid));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ title: 'Save OGraf package', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    });
    ipcMain.handle('select-directory', async event => {
      if (!mainWindow || event.sender !== mainWindow.webContents || new URL(event.senderFrame.url).origin !== origin) throw new Error('Invalid request.');
      const result = await dialog.showOpenDialog(mainWindow, { title: 'Select a folder', properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    });
    try {
      origin = await startBackend();
      const html = await (await fetch(origin)).text();
      backendToken = html.match(/name="grafbridge-token" content="([^"]+)"/)[1];
      mainWindow = createWindow(origin);
      mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
      // Optional smoke test for CI: renderer loaded and screenshot produced by Electron itself.
      if (process.env.GRAFBRIDGE_SMOKE_TEST === '1') {
        mainWindow.webContents.once('did-finish-load', async () => {
          try {
            const valid = await mainWindow.webContents.executeJavaScript("document.title.includes('GrafBridge') && !!document.getElementById('convert') && typeof window.grafbridge?.selectDirectory === 'function' && !document.getElementById('browse-source').hidden");
            if (!valid) throw new Error('The interface did not load.');
            const image = await mainWindow.webContents.capturePage();
            const screenshotRoot = app.isPackaged ? app.getPath('userData') : path.join(root, 'build');
            fs.mkdirSync(screenshotRoot, { recursive: true });
            fs.writeFileSync(path.join(screenshotRoot, 'electron-preview.png'), image.toPNG());
            console.log('GrafBridge Electron smoke test OK');
            app.quit();
          } catch (error) { console.error(error); app.exit(1); }
        });
      }
    } catch (error) { if (backend && !backend.killed) backend.kill(); if (process.env.GRAFBRIDGE_SMOKE_TEST === '1') console.error(error); else dialog.showErrorBox('GrafBridge — Unable to start', error.message); app.exit(1); }
  });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (shutdownComplete || !backend || backend.exitCode !== null) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  const stop = origin && backendToken
    ? fetch(origin + '/api/shutdown', { method: 'POST', headers: {'X-GrafBridge-Token': backendToken, 'Content-Type': 'application/json'}, body: '{}', signal: AbortSignal.timeout(5000) })
    : Promise.reject(new Error('Engine not ready'));
  stop.catch(() => { if (!backend.killed) backend.kill(); }).finally(() => { shutdownComplete = true; app.quit(); });
});
