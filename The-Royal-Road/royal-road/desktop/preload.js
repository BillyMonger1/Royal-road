const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('royal', {
  loadJournal: () => ipcRenderer.invoke('journal:load'),
  saveJournal: db => ipcRenderer.invoke('journal:save', db),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: patch => ipcRenderer.invoke('settings:save', patch),
  ai: req => ipcRenderer.invoke('ai', req),
  transcribe: (audio, mime) => ipcRenderer.invoke('transcribe', audio, mime),
  saveImage: data => ipcRenderer.invoke('image:save', data),
  generateImage: prompt => ipcRenderer.invoke('image:generate', prompt),
  deleteImages: ids => ipcRenderer.invoke('image:delete', ids),
  exportObsidian: backup => ipcRenderer.invoke('export:obsidian', backup),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: on => ipcRenderer.invoke('autostart:set', on)
});
