const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('grafbridge', {
  selectDirectory: () => ipcRenderer.invoke('select-directory')
});
