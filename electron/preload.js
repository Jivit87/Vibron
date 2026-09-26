/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  openFolder: () => ipcRenderer.invoke('viberon:open-folder'),
  newWindow: () => ipcRenderer.invoke('viberon:new-window'),
  openTerminal: (cwd) => ipcRenderer.invoke('viberon:open-terminal', cwd)
});
