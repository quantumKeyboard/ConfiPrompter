const api = window.electronAPI;

const $ = (id) => document.getElementById(id);

const els = {
  statusLine: $('status-line'),
  stealthChip: $('stealth-chip'),
  stealthChipLabel: $('stealth-chip-label'),
  playBtn: $('play-btn'),
  backBtn: $('back-btn'),
  fwdBtn: $('fwd-btn'),
  resetBtn: $('reset-btn'),
  playbackState: $('playback-state'),
  timeReadout: $('time-readout'),
  voiceChip: $('voice-chip'),
  voiceChipLevel: $('voice-chip-level'),
  progress: $('progress'),
  progressFill: $('progress-fill'),
  progressThumb: $('progress-thumb'),
  loadFileBtn: $('load-file-btn'),
  librarySelect: $('library-select'),
  libraryDelete: $('library-delete'),
  librarySave: $('library-save'),
  libraryMessage: $('library-message'),
  scriptName: $('script-name'),
  scriptInput: $('script-input'),
  dropZone: $('drop-zone'),
  fileName: $('file-name'),
  wordStats: $('word-stats'),
  textSwatches: $('text-swatches'),
  micSelect: $('mic-select'),
  micRefresh: $('mic-refresh'),
  micTest: $('mic-test'),
  meter: $('meter'),
  meterFill: $('meter-fill'),
  meterThreshold: $('meter-threshold'),
  voiceStatus: $('voice-status'),
  stealthSupport: $('stealth-support'),
  hoverHint: $('hover-hint'),
  snapCamera: $('snap-camera'),
  togglePrompter: $('toggle-prompter'),
  shortcutList: $('shortcut-list'),
  shortcutFailures: $('shortcut-failures')
};

const READING_WPM = 150;

let settings = {};
let platform = { stealthSupported: true, mouseForwardingSupported: true, shortcutFailures: [] };
const state = {
  hasText: false,
  isPlaying: false,
  isAtEnd: false,
  progress: 0,
  countdown: 0,
  remainingSec: 0,
  elapsedSec: 0,
  prompterVisible: true
};
let micTesting = false;
let micTestTimer = null;
let micTestStartedAt = 0;
let currentLibraryId = '';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function send(channel, data) {
  api.sendCommand(channel, data);
}

function updateSetting(key, value) {
  send('update-settings', { [key]: value });
}

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const rest = String(s % 60).padStart(2, '0');
  return `${m}:${rest}`;
}

function countWords(text) {
  const plain = String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/^#{1,6}\s+/gm, ' ')
    .replace(/\*\*/g, '');
  const matches = plain.match(/\S+/g);
  return matches ? matches.length : 0;
}

function setRangeFill(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${Math.min(100, Math.max(0, pct))}%`);
}

const READOUT_FORMATS = {
  speed: (v) => `${v} px/s`,
  fontSize: (v) => `${v} px`,
  lineHeight: (v) => `${Number(v).toFixed(2)}×`,
  opacity: (v) => `${Math.round(v * 100)}%`,
  focusPosition: (v) => `${Math.round(v * 100)}% from top`,
  voiceSensitivity: (v) => `${v}`,
  voiceHoldMs: (v) => `${(v / 1000).toFixed(1)} s`,
  countdown: (v) => (Number(v) === 0 ? 'Off' : `${v} s`)
};

// ---------------------------------------------------------------------------
// Generic settings binding: every [data-setting] input edits that key, and
// every settings-updated broadcast writes back to all bound inputs.
// ---------------------------------------------------------------------------

const boundInputs = Array.from(document.querySelectorAll('[data-setting]'));

function readInput(input) {
  if (input.type === 'checkbox') {
    return input.checked;
  }
  if (input.type === 'range') {
    return Number(input.value);
  }
  return input.value;
}

for (const input of boundInputs) {
  const key = input.dataset.setting;
  const eventName = input.type === 'range' || input.type === 'color' ? 'input' : 'change';

  input.addEventListener(eventName, () => {
    if (input.type === 'radio' && !input.checked) {
      return;
    }
    const value = readInput(input);
    settings[key] = value;
    if (input.type === 'range') {
      setRangeFill(input);
    }
    renderReadouts();
    updateSetting(key, value);
  });
}

function applySettingsToInputs() {
  for (const input of boundInputs) {
    const key = input.dataset.setting;
    if (!(key in settings)) {
      continue;
    }
    const value = settings[key];

    // Don't fight the user mid-drag.
    if (document.activeElement === input && input.type === 'range') {
      setRangeFill(input);
      continue;
    }

    if (input.type === 'checkbox') {
      input.checked = Boolean(value);
    } else if (input.type === 'radio') {
      input.checked = input.value === value;
    } else {
      input.value = String(value);
    }

    if (input.type === 'range') {
      setRangeFill(input);
    }
  }

  for (const swatch of els.textSwatches.querySelectorAll('.swatch[data-color]')) {
    swatch.classList.toggle('is-selected', swatch.dataset.color === settings.textColor);
  }

  renderReadouts();
  renderSettingsDependentUi();
}

function renderReadouts() {
  for (const output of document.querySelectorAll('[data-readout]')) {
    const key = output.dataset.readout;
    if (key in settings) {
      const format = READOUT_FORMATS[key] || String;
      output.textContent = format(settings[key]);
    }
  }
}

function renderSettingsDependentUi() {
  const stealthOn = Boolean(settings.stealthMode);
  els.stealthChip.classList.toggle('is-off', platform.stealthSupported && !stealthOn);
  els.stealthChip.classList.toggle('is-unsupported', !platform.stealthSupported);
  if (!platform.stealthSupported) {
    els.stealthChipLabel.textContent = 'Stealth n/a';
  } else {
    els.stealthChipLabel.textContent = stealthOn ? 'Hidden from share' : 'Visible to share';
  }

  els.voiceChip.classList.toggle('is-on', Boolean(settings.voiceMode));
  els.shortcutList.classList.toggle('is-disabled', !settings.globalShortcuts);
  renderState();
}

// ---------------------------------------------------------------------------
// Playback state
// ---------------------------------------------------------------------------

function renderState() {
  const active = state.isPlaying || state.countdown > 0;
  els.playBtn.classList.toggle('is-playing', active);
  els.playBtn.setAttribute('aria-label', active ? 'Pause' : 'Play');

  for (const button of [els.playBtn, els.backBtn, els.fwdBtn, els.resetBtn]) {
    button.disabled = !state.hasText;
  }

  let label;
  if (!state.hasText) {
    label = 'No script';
  } else if (state.countdown > 0) {
    label = `Starting in ${state.countdown}…`;
  } else if (state.isAtEnd) {
    label = 'End of script';
  } else if (state.isPlaying) {
    label = settings.voiceMode ? 'Listening' : 'Playing';
  } else {
    label = 'Paused';
  }
  els.playbackState.textContent = label;

  const pct = Math.round(state.progress * 100);
  els.progressFill.style.transform = `scaleX(${state.progress})`;
  els.progressThumb.style.left = `${state.progress * 100}%`;
  els.progress.setAttribute('aria-valuenow', String(pct));

  if (!state.hasText) {
    els.timeReadout.textContent = '—';
  } else if (settings.voiceMode) {
    els.timeReadout.textContent = `${pct}% · ${formatTime(state.elapsedSec)} elapsed`;
  } else {
    els.timeReadout.textContent = `${pct}% · ${formatTime(state.remainingSec)} left`;
  }

  els.togglePrompter.textContent = state.prompterVisible ? 'Hide teleprompter' : 'Show teleprompter';
}

els.playBtn.addEventListener('click', () => {
  send(state.isPlaying || state.countdown > 0 ? 'pause' : 'play');
});
els.resetBtn.addEventListener('click', () => send('reset'));
els.backBtn.addEventListener('click', () => send('jump', { direction: -1 }));
els.fwdBtn.addEventListener('click', () => send('jump', { direction: 1 }));
els.voiceChip.addEventListener('click', () => updateSetting('voiceMode', !settings.voiceMode));
els.stealthChip.addEventListener('click', () => updateSetting('stealthMode', !settings.stealthMode));

// Seekable progress bar
function seekFromPointer(event) {
  const rect = els.progress.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  state.progress = ratio;
  renderState();
  send('seek', { progress: ratio });
}

els.progress.addEventListener('pointerdown', (event) => {
  if (!state.hasText) {
    return;
  }
  els.progress.setPointerCapture(event.pointerId);
  seekFromPointer(event);
  const move = (e) => seekFromPointer(e);
  const up = () => {
    els.progress.removeEventListener('pointermove', move);
    els.progress.removeEventListener('pointerup', up);
  };
  els.progress.addEventListener('pointermove', move);
  els.progress.addEventListener('pointerup', up);
});

els.progress.addEventListener('keydown', (event) => {
  const step = event.shiftKey ? 0.1 : 0.02;
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault();
    const next = Math.min(1, Math.max(0, state.progress + (event.key === 'ArrowRight' ? step : -step)));
    send('seek', { progress: next });
  }
});

for (const button of document.querySelectorAll('[data-nudge]')) {
  button.addEventListener('click', () => {
    const key = button.dataset.nudge;
    updateSetting(key, Number(settings[key] || 0) + Number(button.dataset.step));
  });
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const tabs = Array.from(document.querySelectorAll('.tab'));
const panels = Array.from(document.querySelectorAll('.panel'));

function selectTab(name) {
  for (const tab of tabs) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  for (const panel of panels) {
    panel.hidden = panel.dataset.panel !== name;
  }
  if (name === 'voice') {
    refreshMicList();
  }
  try {
    localStorage.setItem('confiprompter.tab', name);
  } catch (_error) {
    // ignore
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
}

// ---------------------------------------------------------------------------
// Script editing, files, library
// ---------------------------------------------------------------------------

function renderWordStats() {
  const words = countWords(els.scriptInput.value);
  const minutes = words / READING_WPM;
  els.wordStats.textContent = words
    ? `${words.toLocaleString()} words · ~${formatTime(minutes * 60)} at ${READING_WPM} wpm`
    : '0 words';
}

function showLibraryMessage(message, kind = '') {
  els.libraryMessage.textContent = message || '';
  els.libraryMessage.className = `hint ${kind}`;
  if (message) {
    clearTimeout(showLibraryMessage.timer);
    showLibraryMessage.timer = setTimeout(() => {
      els.libraryMessage.textContent = '';
    }, 4000);
  }
}

function setEditorText(text) {
  els.scriptInput.value = text;
  state.hasText = text.trim().length > 0;
  renderWordStats();
  renderState();
}

els.scriptInput.addEventListener('input', () => {
  const text = els.scriptInput.value;
  state.hasText = text.trim().length > 0;
  if (!currentLibraryId) {
    els.fileName.textContent = 'Unsaved script';
  }
  send('set-text', { text, reset: false });
  renderWordStats();
  renderState();
});

function handleLoadResult(result) {
  if (!result || result.canceled) {
    return;
  }
  if (result.error) {
    showLibraryMessage(result.error, 'error');
    return;
  }
  currentLibraryId = '';
  els.librarySelect.value = '';
  els.libraryDelete.disabled = true;
  els.fileName.textContent = result.name || 'Loaded file';
  els.scriptName.value = (result.name || '').replace(/\.[^.]+$/, '');
  setEditorText(result.text || '');
}

els.loadFileBtn.addEventListener('click', async () => {
  handleLoadResult(await api.invoke('open-file-dialog'));
});

// Drag & drop a file anywhere on the window.
let dragDepth = 0;
document.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  els.dropZone.classList.add('is-dragging');
  selectTab('script');
});
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) {
    els.dropZone.classList.remove('is-dragging');
  }
});
document.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  els.dropZone.classList.remove('is-dragging');

  const file = event.dataTransfer?.files?.[0];
  if (!file) {
    return;
  }
  const path = api.getPathForFile(file);
  if (!path) {
    showLibraryMessage('Could not read the dropped file.', 'error');
    return;
  }
  handleLoadResult(await api.invoke('load-file-path', { path }));
});

function renderLibrary(items) {
  const select = els.librarySelect;
  select.textContent = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = items.length ? `Saved scripts (${items.length})…` : 'No saved scripts yet';
  select.appendChild(placeholder);

  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.name} · ${item.words} words`;
    select.appendChild(option);
  }

  select.value = items.some((item) => item.id === currentLibraryId) ? currentLibraryId : '';
  els.libraryDelete.disabled = !select.value;
}

async function refreshLibrary() {
  try {
    renderLibrary(await api.invoke('library-list'));
  } catch (_error) {
    renderLibrary([]);
  }
}

els.librarySelect.addEventListener('change', async () => {
  const id = els.librarySelect.value;
  els.libraryDelete.disabled = !id;
  if (!id) {
    return;
  }
  const result = await api.invoke('library-load', { id });
  if (result?.error) {
    showLibraryMessage(result.error, 'error');
    return;
  }
  currentLibraryId = result.id;
  els.fileName.textContent = `Library · ${result.name}`;
  els.scriptName.value = result.name;
  setEditorText(result.text);
});

els.librarySave.addEventListener('click', async () => {
  const name = els.scriptName.value.trim();
  if (!name) {
    els.scriptName.focus();
    showLibraryMessage('Give the script a name first.', 'error');
    return;
  }
  const result = await api.invoke('library-save', { name, text: els.scriptInput.value });
  if (result?.error) {
    showLibraryMessage(result.error, 'error');
    return;
  }
  currentLibraryId = result.id;
  els.fileName.textContent = `Library · ${name}`;
  renderLibrary(result.items);
  showLibraryMessage(`Saved “${name}”.`);
});

els.scriptName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    els.librarySave.click();
  }
});

els.libraryDelete.addEventListener('click', async () => {
  const id = els.librarySelect.value;
  if (!id) {
    return;
  }
  const option = els.librarySelect.selectedOptions[0];
  const label = option ? option.textContent.split(' · ')[0] : 'script';
  const result = await api.invoke('library-delete', { id });
  if (currentLibraryId === id) {
    currentLibraryId = '';
    els.fileName.textContent = 'Unsaved script';
  }
  renderLibrary(result?.items || []);
  showLibraryMessage(`Deleted “${label}”.`);
});

// ---------------------------------------------------------------------------
// Appearance helpers
// ---------------------------------------------------------------------------

els.textSwatches.addEventListener('click', (event) => {
  const swatch = event.target.closest('.swatch[data-color]');
  if (swatch) {
    settings.textColor = swatch.dataset.color;
    applySettingsToInputs();
    updateSetting('textColor', swatch.dataset.color);
  }
});

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

async function refreshMicList() {
  const select = els.micSelect;
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  } catch (_error) {
    devices = [];
  }

  select.textContent = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'System default';
  select.appendChild(def);

  devices
    .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Microphone ${index + 1}`;
      select.appendChild(option);
    });

  const wanted = settings.micDeviceId || '';
  if (wanted && !Array.from(select.options).some((o) => o.value === wanted)) {
    const missing = document.createElement('option');
    missing.value = wanted;
    missing.textContent = 'Saved mic (not connected)';
    select.appendChild(missing);
  }
  select.value = wanted;
}

els.micSelect.addEventListener('change', () => updateSetting('micDeviceId', els.micSelect.value));
els.micRefresh.addEventListener('click', refreshMicList);
if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', refreshMicList);
}

function setMicTesting(value) {
  micTesting = value;
  clearTimeout(micTestTimer);
  els.micTest.textContent = value ? 'Stop test' : 'Test microphone';
  els.micTest.classList.toggle('is-on', value);
  send('voice-preview', { value });
  if (value) {
    micTestStartedAt = performance.now();
    micTestTimer = setTimeout(() => setMicTesting(false), 20_000);
    // Labels only show up once the mic has been opened at least once.
    setTimeout(refreshMicList, 800);
  }
}

els.micTest.addEventListener('click', () => setMicTesting(!micTesting));

function renderVoice(update) {
  const open = update.status === 'listening';
  els.meter.classList.toggle('active', open);
  els.meter.classList.toggle('speaking', open && update.speaking);
  els.meterFill.style.transform = `scaleX(${open ? update.level : 0})`;
  els.meterThreshold.style.left = `${(update.threshold || 0) * 100}%`;
  els.voiceChipLevel.style.transform = `scaleY(${open ? update.level : 0})`;

  let text = 'Mic off';
  let cls = '';
  if (update.status === 'starting') {
    text = 'Opening mic…';
  } else if (update.status === 'error') {
    text = update.error || 'Mic error';
    cls = 'error';
  } else if (open) {
    text = update.speaking ? 'Speech detected' : 'Listening — mic shared';
    cls = update.speaking ? 'speaking' : '';
  } else if (settings.voiceMode && settings.releaseMicWhenPaused) {
    text = 'Mic released — opens when you press Play';
  }
  els.voiceStatus.textContent = text;
  els.voiceStatus.className = `voice-status ${cls}`;

  // The prompter stops previewing on its own after 20 s; follow it (but
  // ignore updates that were already in flight when the test started).
  if (micTesting && !update.preview && performance.now() - micTestStartedAt > 1500) {
    setMicTesting(false);
  }
}

// ---------------------------------------------------------------------------
// Window tab
// ---------------------------------------------------------------------------

for (const button of document.querySelectorAll('[data-preset]')) {
  button.addEventListener('click', () => send('window-preset', { preset: button.dataset.preset }));
}
els.snapCamera.addEventListener('click', () => send('snap-camera'));
els.togglePrompter.addEventListener('click', () => send('toggle-prompter', { value: !state.prompterVisible }));

function renderPlatform() {
  if (!platform.stealthSupported) {
    els.stealthSupport.textContent =
      'Not supported on Linux — compositors offer no way to exclude a window from capture.';
  } else if (platform.platform === 'darwin') {
    els.stealthSupport.textContent =
      'Excluded from screenshots and most screen sharing. Some newer macOS capture APIs may ignore this — test with your call app first.';
  } else {
    els.stealthSupport.textContent =
      'Excluded from screenshots, recordings and screen sharing (Windows 10 2004 or later).';
  }

  els.hoverHint.textContent = platform.mouseForwardingSupported
    ? 'The overlay is click-through. Hover it to reveal its toolbar; drag its edges to resize.'
    : 'On Linux, hover detection is unavailable while click-through is on — use move / resize mode (Ctrl+Alt+Shift+M) to reach the toolbar.';

  const failures = platform.shortcutFailures || [];
  els.shortcutFailures.hidden = !failures.length;
  els.shortcutFailures.textContent = failures.length
    ? `Already taken by another app: ${failures.join(', ')}`
    : '';

  renderSettingsDependentUi();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

api.onCommand('settings-updated', (next) => {
  settings = { ...settings, ...next };
  applySettingsToInputs();
});

api.onCommand('state-update', (next) => {
  Object.assign(state, next || {});
  els.statusLine.textContent = state.hasText
    ? `${countWords(els.scriptInput.value).toLocaleString()} words ready`
    : 'No script loaded';
  renderState();
});

api.onCommand('text-replaced', (payload) => {
  if (typeof payload?.text === 'string' && payload.text !== els.scriptInput.value) {
    setEditorText(payload.text);
  }
});

api.onCommand('voice-update', (update) => renderVoice(update || {}));

api.onCommand('platform-info', (info) => {
  platform = { ...platform, ...(info || {}) };
  renderPlatform();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async () => {
  try {
    const initial = await api.getInitialState();
    settings = { ...(initial?.settings || {}) };
    platform = { ...platform, ...(initial?.platform || {}) };
    Object.assign(state, initial?.state || {});
    setEditorText(initial?.currentText || '');
  } catch (_error) {
    // Defaults are fine.
  }

  applySettingsToInputs();
  renderPlatform();
  renderWordStats();
  renderState();
  refreshLibrary();

  let savedTab = 'script';
  try {
    savedTab = localStorage.getItem('confiprompter.tab') || 'script';
  } catch (_error) {
    // ignore
  }
  selectTab(tabs.some((t) => t.dataset.tab === savedTab) ? savedTab : 'script');

  els.statusLine.textContent = state.hasText
    ? `${countWords(els.scriptInput.value).toLocaleString()} words ready`
    : 'No script loaded';
})();
