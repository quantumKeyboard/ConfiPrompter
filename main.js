const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  screen
} = require('electron');

const store = require('./utils/settings');
const { loadFile } = require('./utils/fileLoader');

const MIN_PROMPTER_WIDTH = 200;
const MIN_PROMPTER_HEIGHT = 150;
const ALLOWED_COLORS = new Set(['#ffffff', '#ffeb3b', '#111111']);

let prompterWin;
let controlWin;
let boundsSaveTimer;
let isQuitting = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

const runtimeState = {
  speed: clampNumber(store.get('speed', 50), 0, 200),
  fontSize: clampNumber(store.get('fontSize', 32), 16, 72),
  opacity: clampNumber(store.get('opacity', 0.85), 0, 1),
  textColor: sanitizeColor(store.get('textColor', '#ffffff')),
  mirrorMode: Boolean(store.get('mirrorMode', false)),
  highlightLine: Boolean(store.get('highlightLine', true)),
  overlayMovable: Boolean(store.get('overlayMovable', false)),
  currentText: String(store.get('lastInlineText', '')),
  isPlaying: false,
  progress: 0,
  isAtEnd: false,
  hasText: false
};

runtimeState.hasText = runtimeState.currentText.trim().length > 0;

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, toNumber(value, min)));
}

function sanitizeColor(value) {
  const normalized = String(value || '').toLowerCase();
  return ALLOWED_COLORS.has(normalized) ? normalized : '#ffffff';
}

function sendToPrompter(channel, payload) {
  if (prompterWin && !prompterWin.isDestroyed()) {
    prompterWin.webContents.send(channel, payload);
  }
}

function sendToControl(channel, payload) {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send(channel, payload);
  }
}

function broadcastStateUpdate() {
  sendToControl('state-update', {
    isPlaying: runtimeState.isPlaying,
    progress: runtimeState.progress,
    hasText: runtimeState.hasText,
    isAtEnd: runtimeState.isAtEnd
  });
}

function broadcastSettingsUpdate() {
  sendToControl('settings-updated', {
    speed: runtimeState.speed,
    fontSize: runtimeState.fontSize,
    opacity: runtimeState.opacity,
    textColor: runtimeState.textColor,
    mirrorMode: runtimeState.mirrorMode,
    highlightLine: runtimeState.highlightLine,
    overlayMovable: runtimeState.overlayMovable
  });
}

function pushPrompterSettings() {
  sendToPrompter('set-speed', { value: runtimeState.speed });
  sendToPrompter('set-font-size', { value: runtimeState.fontSize });
  sendToPrompter('set-opacity', { value: runtimeState.opacity });
  sendToPrompter('set-color', { color: runtimeState.textColor });
  sendToPrompter('toggle-mirror', { value: runtimeState.mirrorMode });
  sendToPrompter('set-highlight', { value: runtimeState.highlightLine });
  sendToPrompter('set-movable', { value: runtimeState.overlayMovable });

  if (runtimeState.currentText) {
    sendToPrompter('set-text', { text: runtimeState.currentText });
  }
}

function applyPrompterMouseBehavior() {
  if (!prompterWin || prompterWin.isDestroyed()) {
    return;
  }

  if (runtimeState.overlayMovable) {
    prompterWin.setIgnoreMouseEvents(false);
    return;
  }

  prompterWin.setIgnoreMouseEvents(true, { forward: true });
}

function showAppWindows(focusControl = false) {
  if (prompterWin && !prompterWin.isDestroyed() && !prompterWin.isVisible()) {
    prompterWin.show();
  }

  if (controlWin && !controlWin.isDestroyed() && !controlWin.isVisible()) {
    controlWin.show();
  }

  if (focusControl && controlWin && !controlWin.isDestroyed()) {
    controlWin.focus();
  }
}

function hideToBackground(windowRef) {
  windowRef.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    windowRef.hide();
  });
}

function clampBounds(rawBounds) {
  const primary = screen.getPrimaryDisplay().workArea;
  const guessedPoint = {
    x: toNumber(rawBounds?.x, primary.x + 100),
    y: toNumber(rawBounds?.y, primary.y + 50)
  };

  const workArea = screen.getDisplayNearestPoint(guessedPoint).workArea;
  const width = clampNumber(
    toNumber(rawBounds?.width, 420),
    MIN_PROMPTER_WIDTH,
    workArea.width
  );
  const height = clampNumber(
    toNumber(rawBounds?.height, 300),
    MIN_PROMPTER_HEIGHT,
    workArea.height
  );

  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;

  return {
    width,
    height,
    x: clampNumber(guessedPoint.x, workArea.x, maxX),
    y: clampNumber(guessedPoint.y, workArea.y, maxY)
  };
}

function persistPrompterBoundsSoon() {
  clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    if (!prompterWin || prompterWin.isDestroyed()) {
      return;
    }

    store.set('windowBounds', prompterWin.getBounds());
  }, 150);
}

function createPrompterWindow() {
  const restoredBounds = clampBounds(store.get('windowBounds'));

  prompterWin = new BrowserWindow({
    ...restoredBounds,
    minWidth: MIN_PROMPTER_WIDTH,
    minHeight: MIN_PROMPTER_HEIGHT,
    frame: false,
    transparent: true,
    show: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    hasShadow: false,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.platform === 'darwin') {
    prompterWin.setAlwaysOnTop(true, 'screen-saver');
    prompterWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  applyPrompterMouseBehavior();
  prompterWin.loadFile(path.join(__dirname, 'teleprompter', 'teleprompter.html'));

  prompterWin.once('ready-to-show', () => {
    if (!prompterWin.isDestroyed()) {
      prompterWin.show();
    }
  });

  prompterWin.webContents.on('did-finish-load', () => {
    pushPrompterSettings();
  });

  prompterWin.on('move', persistPrompterBoundsSoon);
  prompterWin.on('resize', persistPrompterBoundsSoon);
  hideToBackground(prompterWin);
  prompterWin.on('closed', () => {
    prompterWin = null;
  });
}

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 380,
    height: 640,
    minWidth: 360,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  controlWin.loadFile(path.join(__dirname, 'control', 'control.html'));

  controlWin.once('ready-to-show', () => {
    if (!controlWin.isDestroyed()) {
      controlWin.show();
      controlWin.focus();
    }
  });

  controlWin.webContents.on('did-finish-load', () => {
    broadcastSettingsUpdate();
    broadcastStateUpdate();
  });

  hideToBackground(controlWin);
  controlWin.on('closed', () => {
    controlWin = null;
  });
}

function createWindows() {
  createPrompterWindow();
  createControlWindow();
}

function setSpeed(value) {
  const next = clampNumber(value, 0, 200);
  runtimeState.speed = next;
  store.set('speed', next);
  sendToPrompter('set-speed', { value: next });
  broadcastSettingsUpdate();
}

function setFontSize(value) {
  const next = clampNumber(value, 16, 72);
  runtimeState.fontSize = next;
  store.set('fontSize', next);
  sendToPrompter('set-font-size', { value: next });
  broadcastSettingsUpdate();
}

function setOpacity(value) {
  const next = clampNumber(value, 0, 1);
  runtimeState.opacity = next;
  store.set('opacity', next);
  sendToPrompter('set-opacity', { value: next });
  broadcastSettingsUpdate();
}

function setOverlayMovable(value) {
  const next = Boolean(value);
  runtimeState.overlayMovable = next;
  store.set('overlayMovable', next);
  applyPrompterMouseBehavior();
  sendToPrompter('set-movable', { value: next });
  broadcastSettingsUpdate();
}

function setTextColor(color) {
  const next = sanitizeColor(color);
  runtimeState.textColor = next;
  store.set('textColor', next);
  sendToPrompter('set-color', { color: next });
  broadcastSettingsUpdate();
}

function setMirrorMode(value) {
  const next = Boolean(value);
  runtimeState.mirrorMode = next;
  store.set('mirrorMode', next);
  sendToPrompter('toggle-mirror', { value: next });
  broadcastSettingsUpdate();
}

function setHighlightLine(value) {
  const next = Boolean(value);
  runtimeState.highlightLine = next;
  store.set('highlightLine', next);
  sendToPrompter('set-highlight', { value: next });
  broadcastSettingsUpdate();
}

function applyText(rawText, source = 'inline') {
  const nextText = typeof rawText === 'string' ? rawText : '';

  runtimeState.currentText = nextText;
  runtimeState.hasText = nextText.trim().length > 0;
  runtimeState.isAtEnd = false;
  runtimeState.progress = 0;

  if (source === 'inline') {
    store.set('lastInlineText', nextText);
  }

  sendToPrompter('set-text', { text: nextText });
  broadcastStateUpdate();
}

function togglePlayPause() {
  if (!runtimeState.hasText) {
    return;
  }

  sendToPrompter('toggle-play');
}

function adjustSpeed(delta) {
  setSpeed(runtimeState.speed + delta);
}

function registerGlobalShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    togglePlayPause();
  });

  globalShortcut.register('CommandOrControl+Shift+R', () => {
    sendToPrompter('reset');
  });

  globalShortcut.register('CommandOrControl+Shift+Up', () => {
    adjustSpeed(10);
  });

  globalShortcut.register('CommandOrControl+Shift+Down', () => {
    adjustSpeed(-10);
  });

  globalShortcut.register('CommandOrControl+Shift+L', () => {
    showAppWindows(true);
  });

  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    isQuitting = true;
    app.quit();
  });
}

function registerIpcHandlers() {
  ipcMain.on('set-speed', (_event, payload) => {
    setSpeed(payload?.value);
  });

  ipcMain.on('set-font-size', (_event, payload) => {
    setFontSize(payload?.value);
  });

  ipcMain.on('set-opacity', (_event, payload) => {
    setOpacity(payload?.value);
  });

  ipcMain.on('set-color', (_event, payload) => {
    setTextColor(payload?.color);
  });

  ipcMain.on('set-text', (_event, payload) => {
    applyText(payload?.text, payload?.source || 'inline');
  });

  ipcMain.on('toggle-mirror', (_event, payload) => {
    const value = typeof payload?.value === 'boolean' ? payload.value : !runtimeState.mirrorMode;
    setMirrorMode(value);
  });

  ipcMain.on('set-highlight', (_event, payload) => {
    setHighlightLine(payload?.value);
  });

  ipcMain.on('set-overlay-movable', (_event, payload) => {
    setOverlayMovable(payload?.value);
  });

  ipcMain.on('play', () => {
    if (!runtimeState.hasText) {
      return;
    }

    sendToPrompter('play');
  });

  ipcMain.on('pause', () => {
    sendToPrompter('pause');
  });

  ipcMain.on('reset', () => {
    sendToPrompter('reset');
  });

  ipcMain.on('state-update', (_event, payload) => {
    runtimeState.isPlaying = Boolean(payload?.isPlaying);
    runtimeState.progress = clampNumber(payload?.progress ?? runtimeState.progress, 0, 1);
    runtimeState.isAtEnd = Boolean(payload?.isAtEnd);

    if (typeof payload?.hasText === 'boolean') {
      runtimeState.hasText = payload.hasText;
    }

    broadcastStateUpdate();
  });

  ipcMain.on('enable-mouse', () => {
    if (runtimeState.overlayMovable) {
      return;
    }

    if (prompterWin && !prompterWin.isDestroyed()) {
      prompterWin.setIgnoreMouseEvents(false);
    }
  });

  ipcMain.on('disable-mouse', () => {
    if (runtimeState.overlayMovable) {
      return;
    }

    if (prompterWin && !prompterWin.isDestroyed()) {
      prompterWin.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  ipcMain.on('open-file-dialog', async () => {
    try {
      const parent =
        (controlWin && !controlWin.isDestroyed() && controlWin) ||
        (prompterWin && !prompterWin.isDestroyed() && prompterWin) ||
        null;

      const result = await dialog.showOpenDialog(parent, {
        title: 'Load Script',
        properties: ['openFile'],
        filters: [
          { name: 'Script files', extensions: ['txt', 'md', 'docx'] },
          { name: 'Text files', extensions: ['txt', 'md'] },
          { name: 'Word files', extensions: ['docx'] }
        ]
      });

      if (result.canceled || !result.filePaths.length) {
        return;
      }

      const selectedPath = result.filePaths[0];
      const text = await loadFile(selectedPath);

      applyText(text, 'file');
      sendToControl('file-loaded', {
        name: path.basename(selectedPath),
        text
      });
    } catch (error) {
      sendToControl('file-loaded', {
        error: error instanceof Error ? error.message : 'Failed to load the selected file.'
      });
    }
  });

  ipcMain.handle('get-initial-state', () => ({
    speed: runtimeState.speed,
    fontSize: runtimeState.fontSize,
    opacity: runtimeState.opacity,
    textColor: runtimeState.textColor,
    mirrorMode: runtimeState.mirrorMode,
    highlightLine: runtimeState.highlightLine,
    overlayMovable: runtimeState.overlayMovable,
    currentText: runtimeState.currentText,
    hasText: runtimeState.hasText,
    isPlaying: runtimeState.isPlaying,
    progress: runtimeState.progress
  }));
}

app.on('second-instance', () => {
  showAppWindows(true);
});

if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    registerIpcHandlers();
    createWindows();
    registerGlobalShortcuts();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindows();
        return;
      }

      showAppWindows(true);
    });
  });
}

app.on('window-all-closed', () => {
  // Keep process alive in background; users can reopen windows with Ctrl/Cmd+Shift+L.
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
