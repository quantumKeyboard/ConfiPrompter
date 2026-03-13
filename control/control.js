const loadFileButton = document.getElementById('load-file-btn');
const fileNameLabel = document.getElementById('file-name');
const scriptInput = document.getElementById('script-input');

const playButton = document.getElementById('play-btn');
const pauseButton = document.getElementById('pause-btn');
const resetButton = document.getElementById('reset-btn');

const playbackState = document.getElementById('playback-state');
const progressValue = document.getElementById('progress-value');

const speedSlider = document.getElementById('speed-slider');
const speedReadout = document.getElementById('speed-readout');
const fontSlider = document.getElementById('font-slider');
const fontReadout = document.getElementById('font-readout');
const opacitySlider = document.getElementById('opacity-slider');
const opacityReadout = document.getElementById('opacity-readout');

const mirrorToggle = document.getElementById('mirror-toggle');
const highlightToggle = document.getElementById('highlight-toggle');
const movableToggle = document.getElementById('movable-toggle');

const colorInputs = Array.from(document.querySelectorAll("input[name='text-color']"));

const uiState = {
  hasText: false,
  isPlaying: false,
  isAtEnd: false,
  progress: 0
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function send(channel, data) {
  window.electronAPI.sendCommand(channel, data);
}

function setPlaybackLabel() {
  if (!uiState.hasText) {
    playbackState.textContent = 'No script';
    return;
  }

  if (uiState.isAtEnd) {
    playbackState.textContent = 'End of script';
    return;
  }

  playbackState.textContent = uiState.isPlaying ? 'Playing' : 'Paused';
}

function updateButtons() {
  playButton.disabled = !uiState.hasText;
  pauseButton.disabled = !uiState.hasText;
  resetButton.disabled = !uiState.hasText;
  setPlaybackLabel();
}

function updateReadouts() {
  speedReadout.textContent = `${speedSlider.value} px/s`;
  fontReadout.textContent = `${fontSlider.value} px`;
  opacityReadout.textContent = `${opacitySlider.value}%`;
  progressValue.textContent = `${Math.round(uiState.progress * 100)}%`;
}

function applySettings(settings) {
  if (typeof settings?.speed === 'number') {
    speedSlider.value = String(clamp(settings.speed, 0, 200));
  }

  if (typeof settings?.fontSize === 'number') {
    fontSlider.value = String(clamp(settings.fontSize, 16, 72));
  }

  if (typeof settings?.opacity === 'number') {
    opacitySlider.value = String(Math.round(clamp(settings.opacity, 0, 1) * 100));
  }

  if (typeof settings?.mirrorMode === 'boolean') {
    mirrorToggle.checked = settings.mirrorMode;
  }

  if (typeof settings?.highlightLine === 'boolean') {
    highlightToggle.checked = settings.highlightLine;
  }

  if (typeof settings?.overlayMovable === 'boolean') {
    movableToggle.checked = settings.overlayMovable;
  }

  if (settings?.textColor) {
    for (const radio of colorInputs) {
      radio.checked = radio.value.toLowerCase() === settings.textColor.toLowerCase();
    }
  }

  updateReadouts();
}

loadFileButton.addEventListener('click', () => {
  send('open-file-dialog');
});

scriptInput.addEventListener('input', () => {
  const text = scriptInput.value;
  uiState.hasText = text.trim().length > 0;
  uiState.isAtEnd = false;
  fileNameLabel.textContent = 'Inline text';

  send('set-text', {
    text,
    source: 'inline'
  });

  updateButtons();
  updateReadouts();
});

playButton.addEventListener('click', () => {
  send('play');
});

pauseButton.addEventListener('click', () => {
  send('pause');
});

resetButton.addEventListener('click', () => {
  send('reset');
});

speedSlider.addEventListener('input', () => {
  updateReadouts();
  send('set-speed', { value: Number(speedSlider.value) });
});

fontSlider.addEventListener('input', () => {
  updateReadouts();
  send('set-font-size', { value: Number(fontSlider.value) });
});

opacitySlider.addEventListener('input', () => {
  updateReadouts();
  send('set-opacity', { value: Number(opacitySlider.value) / 100 });
});

for (const radio of colorInputs) {
  radio.addEventListener('change', () => {
    if (radio.checked) {
      send('set-color', { color: radio.value });
    }
  });
}

mirrorToggle.addEventListener('change', () => {
  send('toggle-mirror', { value: mirrorToggle.checked });
});

highlightToggle.addEventListener('change', () => {
  send('set-highlight', { value: highlightToggle.checked });
});

movableToggle.addEventListener('change', () => {
  send('set-overlay-movable', { value: movableToggle.checked });
});

window.electronAPI.onCommand('file-loaded', (payload) => {
  if (payload?.error) {
    fileNameLabel.textContent = `Error: ${payload.error}`;
    return;
  }

  fileNameLabel.textContent = payload?.name || 'Loaded file';

  if (typeof payload?.text === 'string') {
    scriptInput.value = payload.text;
    uiState.hasText = payload.text.trim().length > 0;
    uiState.isAtEnd = false;
    uiState.progress = 0;
    updateButtons();
    updateReadouts();
  }
});

window.electronAPI.onCommand('state-update', (payload) => {
  if (typeof payload?.isPlaying === 'boolean') {
    uiState.isPlaying = payload.isPlaying;
  }

  if (typeof payload?.hasText === 'boolean') {
    uiState.hasText = payload.hasText;
  }

  if (typeof payload?.isAtEnd === 'boolean') {
    uiState.isAtEnd = payload.isAtEnd;
  }

  if (typeof payload?.progress === 'number') {
    uiState.progress = clamp(payload.progress, 0, 1);
  }

  updateButtons();
  updateReadouts();
});

window.electronAPI.onCommand('settings-updated', (payload) => {
  applySettings(payload || {});
});

(async () => {
  try {
    const initial = await window.electronAPI.getInitialState();
    applySettings(initial || {});

    if (typeof initial?.currentText === 'string') {
      scriptInput.value = initial.currentText;
      uiState.hasText = initial.currentText.trim().length > 0;
    }

    if (typeof initial?.isPlaying === 'boolean') {
      uiState.isPlaying = initial.isPlaying;
    }

    if (typeof initial?.progress === 'number') {
      uiState.progress = clamp(initial.progress, 0, 1);
    }
  } catch (_error) {
    uiState.hasText = scriptInput.value.trim().length > 0;
  }

  updateButtons();
  updateReadouts();
})();
