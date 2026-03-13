const { contextBridge, ipcRenderer } = require('electron');

const sendChannels = new Set([
  'set-speed',
  'set-font-size',
  'set-opacity',
  'set-text',
  'play',
  'pause',
  'reset',
  'set-color',
  'toggle-mirror',
  'open-file-dialog',
  'enable-mouse',
  'disable-mouse',
  'set-highlight',
  'set-overlay-movable',
  'state-update'
]);

const receiveChannels = new Set([
  'set-speed',
  'set-font-size',
  'set-opacity',
  'set-text',
  'play',
  'pause',
  'reset',
  'set-color',
  'toggle-mirror',
  'toggle-play',
  'file-loaded',
  'state-update',
  'settings-updated',
  'set-highlight',
  'set-movable'
]);

contextBridge.exposeInMainWorld('electronAPI', {
  sendCommand: (channel, data) => {
    if (!sendChannels.has(channel)) {
      return;
    }

    ipcRenderer.send(channel, data);
  },

  onCommand: (channel, callback) => {
    if (!receiveChannels.has(channel) || typeof callback !== 'function') {
      return () => {};
    }

    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);

    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },

  getInitialState: () => ipcRenderer.invoke('get-initial-state'),

  enableMouse: () => {
    ipcRenderer.send('enable-mouse');
  },

  disableMouse: () => {
    ipcRenderer.send('disable-mouse');
  }
});
