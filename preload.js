const { contextBridge, ipcRenderer, webUtils } = require('electron');

const sendChannels = new Set([
  'update-settings',
  'set-text',
  'play',
  'pause',
  'reset',
  'toggle-play',
  'seek',
  'jump',
  'state-update',
  'voice-update',
  'voice-preview',
  'set-hover-interactive',
  'window-op-start',
  'window-op-end',
  'window-preset',
  'snap-camera',
  'toggle-prompter',
  'show-control'
]);

const receiveChannels = new Set([
  'settings-updated',
  'set-text',
  'text-replaced',
  'play',
  'pause',
  'reset',
  'toggle-play',
  'seek',
  'jump',
  'state-update',
  'voice-update',
  'voice-preview',
  'platform-info'
]);

const invokeChannels = new Set([
  'get-initial-state',
  'open-file-dialog',
  'load-file-path',
  'library-list',
  'library-save',
  'library-load',
  'library-delete',
  'request-mic-access'
]);

contextBridge.exposeInMainWorld('electronAPI', {
  sendCommand: (channel, data) => {
    if (sendChannels.has(channel)) {
      ipcRenderer.send(channel, data);
    }
  },

  onCommand: (channel, callback) => {
    if (!receiveChannels.has(channel) || typeof callback !== 'function') {
      return () => {};
    }

    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  invoke: (channel, data) => {
    if (!invokeChannels.has(channel)) {
      return Promise.reject(new Error(`Channel not allowed: ${channel}`));
    }
    return ipcRenderer.invoke(channel, data);
  },

  getInitialState: () => ipcRenderer.invoke('get-initial-state'),

  // Drag-and-drop: File.path was removed from Electron, this is the replacement.
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (_error) {
      return '';
    }
  }
});
