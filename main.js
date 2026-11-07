const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
  systemPreferences
} = require('electron');

const { store, SETTING_KEYS, validateSetting, loadSettings } = require('./utils/settings');
const { createLibrary } = require('./utils/library');
const { loadFile, SUPPORTED_EXTENSIONS } = require('./utils/fileLoader');

const APP_NAME = 'ConfiPrompter';
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');
const MIN_PROMPTER_WIDTH = 180;
const MIN_PROMPTER_HEIGHT = 64;
const DEFAULT_PROMPTER_SIZE = { width: 520, height: 150 };
const SIZE_PRESETS = {
  compact: { width: 440, height: 120 },
  medium: { width: 640, height: 210 },
  large: { width: 920, height: 340 }
};

const library = createLibrary(store);

let prompterWin = null;
let controlWin = null;
let tray = null;
let boundsSaveTimer = null;
let textSaveTimer = null;
let windowOpTimer = null;
let isQuitting = false;
let prompterHoverInteractive = false;
const shortcutFailures = [];

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

const settings = loadSettings();

const runtimeState = {
  currentText: String(store.get('lastInlineText', '')),
  isPlaying: false,
  progress: 0,
  isAtEnd: false,
  hasText: false,
  countdown: 0,
  remainingSec: 0,
  elapsedSec: 0
};
runtimeState.hasText = runtimeState.currentText.trim().length > 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAlive(win) {
  return Boolean(win && !win.isDestroyed());
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sendToPrompter(channel, payload) {
  if (isAlive(prompterWin)) {
    prompterWin.webContents.send(channel, payload);
  }
}

function sendToControl(channel, payload) {
  if (isAlive(controlWin)) {
    controlWin.webContents.send(channel, payload);
  }
}

function sendToAll(channel, payload) {
  sendToPrompter(channel, payload);
  sendToControl(channel, payload);
}

function publicState() {
  return {
    isPlaying: runtimeState.isPlaying,
    progress: runtimeState.progress,
    hasText: runtimeState.hasText,
    isAtEnd: runtimeState.isAtEnd,
    countdown: runtimeState.countdown,
    remainingSec: runtimeState.remainingSec,
    elapsedSec: runtimeState.elapsedSec,
    prompterVisible: isAlive(prompterWin) && prompterWin.isVisible()
  };
}

function broadcastState() {
  sendToControl('state-update', publicState());
}

function platformInfo() {
  return {
    platform: process.platform,
    // setContentProtection maps to WDA_EXCLUDEFROMCAPTURE on Windows 10 2004+
    // and NSWindowSharingNone on macOS. Linux compositors expose no
    // equivalent, so the option is a no-op there.
    stealthSupported: process.platform === 'win32' || process.platform === 'darwin',
    mouseForwardingSupported: process.platform === 'win32' || process.platform === 'darwin',
    shortcutFailures: [...shortcutFailures]
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function updateSettings(partial) {
  if (!partial || typeof partial !== 'object') {
    return;
  }

  const changed = [];
  for (const key of Object.keys(partial)) {
    if (!SETTING_KEYS.includes(key)) {
      continue;
    }

    const next = validateSetting(key, partial[key]);
    if (next === settings[key]) {
      continue;
    }

    settings[key] = next;
    store.set(key, next);
    changed.push(key);
  }

  if (!changed.length) {
    return;
  }

  if (changed.includes('stealthMode') || changed.includes('stealthControl')) {
    applyStealth();
  }

  if (changed.includes('overlayMovable')) {
    applyPrompterMouseBehavior();
  }

  if (changed.includes('globalShortcuts')) {
    registerGlobalShortcuts();
  }

  sendToAll('settings-updated', { ...settings });
  refreshTrayMenu();
}

function toggleSetting(key) {
  updateSettings({ [key]: !settings[key] });
}

// ---------------------------------------------------------------------------
// Stealth: exclude windows from screen capture / screen sharing
// ---------------------------------------------------------------------------

function applyContentProtection(win, enabled) {
  if (!isAlive(win)) {
    return;
  }

  try {
    win.setContentProtection(Boolean(enabled));
  } catch (error) {
    console.warn('[stealth] setContentProtection failed:', error);
  }
}

function applyStealth() {
  applyContentProtection(prompterWin, settings.stealthMode);
  applyContentProtection(controlWin, settings.stealthMode && settings.stealthControl);
}

// ---------------------------------------------------------------------------
// Prompter window: click-through, custom move/resize, placement
// ---------------------------------------------------------------------------

function applyPrompterMouseBehavior() {
  if (!isAlive(prompterWin)) {
    return;
  }

  const interactive = settings.overlayMovable || prompterHoverInteractive;
  if (interactive) {
    prompterWin.setIgnoreMouseEvents(false);
  } else {
    // `forward` keeps mousemove events flowing to the renderer (Windows/macOS)
    // so it can reveal the hover toolbar and resize grips.
    prompterWin.setIgnoreMouseEvents(true, { forward: true });
  }
}

function clampBounds(rawBounds) {
  const primary = screen.getPrimaryDisplay().workArea;
  const width = toNumber(rawBounds?.width, DEFAULT_PROMPTER_SIZE.width);
  const height = toNumber(rawBounds?.height, DEFAULT_PROMPTER_SIZE.height);
  const fallbackX = Math.round(primary.x + (primary.width - width) / 2);
  const fallbackY = primary.y + 12;

  const point = {
    x: Math.round(toNumber(rawBounds?.x, fallbackX)),
    y: Math.round(toNumber(rawBounds?.y, fallbackY))
  };
  const workArea = screen.getDisplayNearestPoint(point).workArea;

  const w = Math.round(clamp(width, MIN_PROMPTER_WIDTH, workArea.width));
  const h = Math.round(clamp(height, MIN_PROMPTER_HEIGHT, workArea.height));

  return {
    width: w,
    height: h,
    x: Math.round(clamp(point.x, workArea.x, workArea.x + workArea.width - w)),
    y: Math.round(clamp(point.y, workArea.y, workArea.y + workArea.height - h))
  };
}

function persistPrompterBoundsSoon() {
  clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    if (isAlive(prompterWin)) {
      store.set('windowBounds', prompterWin.getBounds());
    }
  }, 200);
}

function currentWorkArea() {
  const bounds = isAlive(prompterWin) ? prompterWin.getBounds() : null;
  const display = bounds
    ? screen.getDisplayMatching(bounds)
    : screen.getPrimaryDisplay();
  return display.workArea;
}

// Place the prompter centred at the top of its display — right under a
// typical laptop/monitor webcam, so your eyes stay close to the lens.
function snapUnderCamera() {
  if (!isAlive(prompterWin)) {
    return;
  }

  const area = currentWorkArea();
  const { width, height } = prompterWin.getBounds();
  prompterWin.setBounds({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y + 8
  });
}

function applySizePreset(name) {
  const preset = SIZE_PRESETS[name];
  if (!preset || !isAlive(prompterWin)) {
    return;
  }

  const area = currentWorkArea();
  const current = prompterWin.getBounds();
  const centerX = current.x + current.width / 2;
  const width = Math.min(preset.width, area.width);
  const height = Math.min(preset.height, area.height);
  prompterWin.setBounds(
    clampBounds({ width, height, x: Math.round(centerX - width / 2), y: current.y })
  );
}

function stopWindowOp() {
  if (windowOpTimer) {
    clearInterval(windowOpTimer);
    windowOpTimer = null;
  }
}

// Frameless transparent windows can't rely on native edge resizing on every
// platform, and `-webkit-app-region: drag` swallows the mouse events we need
// for click-through toggling. So the renderer just says "a drag started on
// edge X" and the main process tracks the global cursor until it says stop.
function startWindowOp(op, edge) {
  if (!isAlive(prompterWin)) {
    return;
  }

  stopWindowOp();

  const startCursor = screen.getCursorScreenPoint();
  const start = prompterWin.getBounds();
  const edgeStr = typeof edge === 'string' ? edge : '';
  const startedAt = Date.now();

  windowOpTimer = setInterval(() => {
    if (!isAlive(prompterWin) || Date.now() - startedAt > 120_000) {
      stopWindowOp();
      return;
    }

    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - startCursor.x;
    const dy = cursor.y - startCursor.y;

    if (op === 'move') {
      prompterWin.setPosition(Math.round(start.x + dx), Math.round(start.y + dy));
      return;
    }

    let { x, y, width, height } = start;

    if (edgeStr.includes('e')) {
      width = Math.max(MIN_PROMPTER_WIDTH, start.width + dx);
    }
    if (edgeStr.includes('s')) {
      height = Math.max(MIN_PROMPTER_HEIGHT, start.height + dy);
    }
    if (edgeStr.includes('w')) {
      width = Math.max(MIN_PROMPTER_WIDTH, start.width - dx);
      x = start.x + start.width - width;
    }
    if (edgeStr.includes('n')) {
      height = Math.max(MIN_PROMPTER_HEIGHT, start.height - dy);
      y = start.y + start.height - height;
    }

    prompterWin.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    });
  }, 16);
}

function togglePrompterVisibility(forceVisible) {
  if (!isAlive(prompterWin)) {
    return;
  }

  const shouldShow = typeof forceVisible === 'boolean' ? forceVisible : !prompterWin.isVisible();
  if (shouldShow) {
    prompterWin.showInactive();
    applyStealth();
  } else {
    prompterWin.hide();
  }

  broadcastState();
  refreshTrayMenu();
}

function showAppWindows(focusControl = false) {
  if (isAlive(prompterWin) && !prompterWin.isVisible()) {
    prompterWin.showInactive();
  }

  if (isAlive(controlWin) && !controlWin.isVisible()) {
    controlWin.show();
  }

  if (focusControl && isAlive(controlWin)) {
    controlWin.focus();
  }

  applyStealth();
  broadcastState();
}

function hideToBackground(win) {
  win.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    win.hide();
    broadcastState();
    refreshTrayMenu();
  });
}

function hardenWebContents(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Dropping a file on a window would otherwise navigate away from the app.
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
}

function createPrompterWindow() {
  const restored = clampBounds(store.get('windowBounds'));

  prompterWin = new BrowserWindow({
    ...restored,
    minWidth: MIN_PROMPTER_WIDTH,
    minHeight: MIN_PROMPTER_HEIGHT,
    title: APP_NAME,
    frame: false,
    transparent: true,
    show: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    hasShadow: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Voice detection and scrolling run on requestAnimationFrame; don't let
      // Chromium throttle them when another app has focus.
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  // Floats above full-screen apps (Keynote, slides, video calls).
  prompterWin.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    prompterWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  applyContentProtection(prompterWin, settings.stealthMode);
  applyPrompterMouseBehavior();
  hardenWebContents(prompterWin);
  prompterWin.loadFile(path.join(__dirname, 'teleprompter', 'teleprompter.html'));

  prompterWin.once('ready-to-show', () => {
    if (isAlive(prompterWin)) {
      prompterWin.showInactive();
      // Some platforms reset the capture flag when the window is first mapped.
      applyStealth();
    }
  });

  prompterWin.on('show', applyStealth);
  prompterWin.on('move', persistPrompterBoundsSoon);
  prompterWin.on('resize', persistPrompterBoundsSoon);
  prompterWin.on('blur', () => {
    if (prompterHoverInteractive) {
      prompterHoverInteractive = false;
      applyPrompterMouseBehavior();
    }
  });

  hideToBackground(prompterWin);
  prompterWin.on('closed', () => {
    stopWindowOp();
    prompterWin = null;
  });
}

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 420,
    height: 760,
    minWidth: 380,
    minHeight: 560,
    title: `${APP_NAME} — Control`,
    icon: APP_ICON,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  applyContentProtection(controlWin, settings.stealthMode && settings.stealthControl);
  hardenWebContents(controlWin);
  controlWin.loadFile(path.join(__dirname, 'control', 'control.html'));

  controlWin.once('ready-to-show', () => {
    if (isAlive(controlWin)) {
      controlWin.show();
      controlWin.focus();
      applyStealth();
    }
  });

  controlWin.on('show', applyStealth);
  hideToBackground(controlWin);
  controlWin.on('closed', () => {
    controlWin = null;
  });
}

function createWindows() {
  createPrompterWindow();
  createControlWindow();
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function createTray() {
  try {
    const iconName = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
    const image = nativeImage.createFromPath(path.join(__dirname, 'assets', iconName));
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    tray.setToolTip(APP_NAME);
    tray.on('click', () => showAppWindows(true));
    refreshTrayMenu();
  } catch (error) {
    console.warn('[tray] unavailable:', error);
    tray = null;
  }
}

function refreshTrayMenu() {
  if (!tray) {
    return;
  }

  const prompterVisible = isAlive(prompterWin) && prompterWin.isVisible();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show control panel', click: () => showAppWindows(true) },
      {
        label: prompterVisible ? 'Hide teleprompter' : 'Show teleprompter',
        click: () => togglePrompterVisibility()
      },
      { type: 'separator' },
      {
        label: runtimeState.isPlaying ? 'Pause' : 'Play',
        enabled: runtimeState.hasText,
        click: () => togglePlayPause()
      },
      { label: 'Reset to top', click: () => sendToPrompter('reset') },
      { type: 'separator' },
      {
        label: 'Voice-reactive scrolling',
        type: 'checkbox',
        checked: settings.voiceMode,
        click: () => toggleSetting('voiceMode')
      },
      {
        label: 'Hide from screen share',
        type: 'checkbox',
        checked: settings.stealthMode,
        click: () => toggleSetting('stealthMode')
      },
      {
        label: 'Move / resize mode',
        type: 'checkbox',
        checked: settings.overlayMovable,
        click: () => toggleSetting('overlayMovable')
      },
      { label: 'Snap under camera', click: () => snapUnderCamera() },
      { type: 'separator' },
      { label: `Quit ${APP_NAME}`, click: () => quitApp() }
    ])
  );
}

// ---------------------------------------------------------------------------
// Playback & text
// ---------------------------------------------------------------------------

function applyText(rawText, { source = 'inline', reset = true } = {}) {
  const nextText = typeof rawText === 'string' ? rawText : '';

  runtimeState.currentText = nextText;
  runtimeState.hasText = nextText.trim().length > 0;
  if (reset) {
    runtimeState.isAtEnd = false;
    runtimeState.progress = 0;
  }

  // Always persist the current script so it survives a restart, but debounce
  // so typing doesn't hit the disk on every keystroke.
  clearTimeout(textSaveTimer);
  textSaveTimer = setTimeout(() => store.set('lastInlineText', nextText), 400);

  sendToPrompter('set-text', { text: nextText, reset });
  if (source !== 'inline') {
    sendToControl('text-replaced', { text: nextText, source });
  }
  broadcastState();
  refreshTrayMenu();
}

function togglePlayPause() {
  if (!runtimeState.hasText) {
    return;
  }

  sendToPrompter('toggle-play');
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

// ---------------------------------------------------------------------------
// Global shortcuts
// ---------------------------------------------------------------------------

const SHORTCUTS = [
  { accelerator: 'CommandOrControl+Shift+Space', action: () => togglePlayPause() },
  { accelerator: 'CommandOrControl+Shift+R', action: () => sendToPrompter('reset') },
  { accelerator: 'CommandOrControl+Shift+Up', action: () => updateSettings({ speed: settings.speed + 10 }) },
  { accelerator: 'CommandOrControl+Shift+Down', action: () => updateSettings({ speed: settings.speed - 10 }) },
  { accelerator: 'CommandOrControl+Shift+L', action: () => showAppWindows(true) },
  { accelerator: 'CommandOrControl+Shift+Q', action: () => quitApp() },
  // Newer shortcuts use Ctrl+Alt+Shift so they don't steal common app combos
  // like Ctrl+Shift+M (mute in Teams) or Ctrl+Shift+V (paste plain text).
  { accelerator: 'CommandOrControl+Alt+Shift+V', action: () => toggleSetting('voiceMode') },
  { accelerator: 'CommandOrControl+Alt+Shift+M', action: () => toggleSetting('overlayMovable') },
  { accelerator: 'CommandOrControl+Alt+Shift+H', action: () => togglePrompterVisibility() },
  { accelerator: 'CommandOrControl+Alt+Shift+S', action: () => toggleSetting('stealthMode') },
  { accelerator: 'CommandOrControl+Alt+Shift+Right', action: () => sendToPrompter('jump', { direction: 1 }) },
  { accelerator: 'CommandOrControl+Alt+Shift+Left', action: () => sendToPrompter('jump', { direction: -1 }) }
];

function registerGlobalShortcuts() {
  globalShortcut.unregisterAll();
  shortcutFailures.length = 0;

  if (settings.globalShortcuts) {
    for (const { accelerator, action } of SHORTCUTS) {
      try {
        if (!globalShortcut.register(accelerator, action)) {
          shortcutFailures.push(accelerator);
        }
      } catch (_error) {
        shortcutFailures.push(accelerator);
      }
    }
  }

  sendToControl('platform-info', platformInfo());
}

// ---------------------------------------------------------------------------
// Microphone permissions
//
// Only audio capture from our own pages is allowed. Video, screen capture and
// every other permission are denied.
// ---------------------------------------------------------------------------

function isOwnWebContents(webContents) {
  return (
    (isAlive(prompterWin) && webContents === prompterWin.webContents) ||
    (isAlive(controlWin) && webContents === controlWin.webContents)
  );
}

function configurePermissions() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission === 'media' && isOwnWebContents(webContents)) {
      const types = details?.mediaTypes || [];
      callback(types.length > 0 && types.every((type) => type === 'audio'));
      return;
    }

    callback(false);
  });

  ses.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    if (permission !== 'media' || !webContents || !isOwnWebContents(webContents)) {
      return false;
    }

    return !details?.mediaType || details.mediaType === 'audio';
  });
}

async function ensureMicAccess() {
  if (process.platform !== 'darwin') {
    return true;
  }

  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') {
      return true;
    }
    return await systemPreferences.askForMediaAccess('microphone');
  } catch (_error) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

async function loadScriptFromPath(filePath) {
  const text = await loadFile(filePath);
  applyText(text, { source: 'file', reset: true });
  return { name: path.basename(filePath), text };
}

function registerIpcHandlers() {
  ipcMain.on('update-settings', (_event, payload) => updateSettings(payload));

  ipcMain.on('set-text', (_event, payload) => {
    applyText(payload?.text, { source: 'inline', reset: Boolean(payload?.reset) });
  });

  for (const channel of ['play', 'pause', 'reset']) {
    ipcMain.on(channel, () => {
      if (channel === 'play' && !runtimeState.hasText) {
        return;
      }
      sendToPrompter(channel);
    });
  }

  ipcMain.on('toggle-play', () => togglePlayPause());

  ipcMain.on('seek', (_event, payload) => {
    sendToPrompter('seek', { progress: clamp(toNumber(payload?.progress, 0), 0, 1) });
  });

  ipcMain.on('jump', (_event, payload) => {
    sendToPrompter('jump', { direction: toNumber(payload?.direction, 1) >= 0 ? 1 : -1 });
  });

  ipcMain.on('voice-preview', (_event, payload) => {
    sendToPrompter('voice-preview', { value: Boolean(payload?.value) });
  });

  ipcMain.on('state-update', (_event, payload) => {
    const wasPlaying = runtimeState.isPlaying;
    runtimeState.isPlaying = Boolean(payload?.isPlaying);
    runtimeState.progress = clamp(toNumber(payload?.progress, runtimeState.progress), 0, 1);
    runtimeState.isAtEnd = Boolean(payload?.isAtEnd);
    runtimeState.countdown = Math.max(0, toNumber(payload?.countdown, 0));
    runtimeState.remainingSec = Math.max(0, toNumber(payload?.remainingSec, 0));
    runtimeState.elapsedSec = Math.max(0, toNumber(payload?.elapsedSec, 0));
    if (typeof payload?.hasText === 'boolean') {
      runtimeState.hasText = payload.hasText;
    }

    broadcastState();
    if (wasPlaying !== runtimeState.isPlaying) {
      refreshTrayMenu();
    }
  });

  ipcMain.on('voice-update', (_event, payload) => {
    sendToControl('voice-update', payload);
  });

  // Prompter asks to become clickable while the cursor is over its toolbar or
  // resize edges, and click-through again when it leaves.
  ipcMain.on('set-hover-interactive', (_event, payload) => {
    const next = Boolean(payload?.value);
    if (next !== prompterHoverInteractive) {
      prompterHoverInteractive = next;
      applyPrompterMouseBehavior();
    }
  });

  ipcMain.on('window-op-start', (_event, payload) => {
    const op = payload?.op === 'resize' ? 'resize' : 'move';
    startWindowOp(op, payload?.edge);
  });
  ipcMain.on('window-op-end', () => stopWindowOp());

  ipcMain.on('window-preset', (_event, payload) => applySizePreset(payload?.preset));
  ipcMain.on('snap-camera', () => snapUnderCamera());
  ipcMain.on('toggle-prompter', (_event, payload) => togglePrompterVisibility(payload?.value));
  ipcMain.on('show-control', () => showAppWindows(true));

  ipcMain.handle('request-mic-access', () => ensureMicAccess());

  ipcMain.handle('open-file-dialog', async () => {
    const parent = (isAlive(controlWin) && controlWin) || null;
    const result = await dialog.showOpenDialog(parent, {
      title: 'Load script',
      properties: ['openFile'],
      filters: [
        { name: 'Scripts', extensions: SUPPORTED_EXTENSIONS },
        { name: 'All files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true };
    }

    try {
      return await loadScriptFromPath(result.filePaths[0]);
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to load the selected file.' };
    }
  });

  ipcMain.handle('load-file-path', async (_event, payload) => {
    try {
      if (typeof payload?.path !== 'string' || !payload.path) {
        throw new Error('No file path provided.');
      }
      return await loadScriptFromPath(payload.path);
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to load the file.' };
    }
  });

  ipcMain.handle('library-list', () => library.summaries());

  ipcMain.handle('library-save', (_event, payload) => {
    try {
      const id = library.save(payload?.name, payload?.text);
      return { id, items: library.summaries() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Could not save script.' };
    }
  });

  ipcMain.handle('library-load', (_event, payload) => {
    const item = library.get(String(payload?.id || ''));
    if (!item) {
      return { error: 'Script not found.' };
    }
    applyText(item.text, { source: 'library', reset: true });
    return { id: item.id, name: item.name, text: item.text };
  });

  ipcMain.handle('library-delete', (_event, payload) => {
    library.remove(String(payload?.id || ''));
    return { items: library.summaries() };
  });

  ipcMain.handle('get-initial-state', () => ({
    settings: { ...settings },
    state: publicState(),
    currentText: runtimeState.currentText,
    platform: platformInfo()
  }));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.on('second-instance', () => {
  showAppWindows(true);
});

if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    configurePermissions();
    registerIpcHandlers();
    createWindows();
    createTray();
    registerGlobalShortcuts();

    screen.on('display-removed', () => {
      if (isAlive(prompterWin)) {
        prompterWin.setBounds(clampBounds(prompterWin.getBounds()));
      }
    });

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
  // Keep running in the background; reopen with Ctrl/Cmd+Shift+L or the tray.
});

app.on('before-quit', () => {
  isQuitting = true;
  clearTimeout(textSaveTimer);
  store.set('lastInlineText', runtimeState.currentText);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
