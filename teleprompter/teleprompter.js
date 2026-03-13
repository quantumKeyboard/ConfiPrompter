const overlay = document.getElementById('overlay');
const dragHandle = document.getElementById('drag-handle');
const viewport = document.getElementById('viewport');
const mirrorShell = document.getElementById('mirror-shell');
const textTrack = document.getElementById('text-track');
const centerGuide = document.getElementById('center-guide');
const endIndicator = document.getElementById('end-indicator');
const emptyState = document.getElementById('empty-state');

let speed = 50;
let fontSize = 32;
let overlayOpacity = 0.85;
let textColor = '#ffffff';
let mirrorMode = false;
let highlightLine = true;
let movableMode = false;

let scrollY = 0;
let maxScroll = 0;
let isPlaying = false;
let hasText = false;
let isAtEnd = false;
let lastTimestamp = null;
let lastStateReport = 0;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function applyStyles() {
  overlay.style.setProperty('--overlay-opacity', String(overlayOpacity));
  overlay.style.setProperty('--font-size', `${fontSize}px`);
  overlay.style.setProperty('--text-color', textColor);

  mirrorShell.style.transform = mirrorMode ? 'scaleX(-1)' : 'none';
  centerGuide.classList.toggle('is-hidden', !highlightLine);
  overlay.classList.toggle('movable-mode', movableMode);
  dragHandle.textContent = movableMode ? 'LensPrompt | Move Mode On' : 'LensPrompt';
}

function updatePadding() {
  const viewportHeight = viewport.clientHeight;
  textTrack.style.paddingTop = `${viewportHeight}px`;
  textTrack.style.paddingBottom = `${viewportHeight}px`;
}

function recomputeScrollLimits() {
  updatePadding();
  maxScroll = Math.max(textTrack.scrollHeight - viewport.clientHeight, 0);

  if (scrollY > maxScroll) {
    scrollY = maxScroll;
  }

  applyTransform();
}

function applyTransform() {
  textTrack.style.transform = `translate3d(0, ${-scrollY}px, 0)`;
}

function reportState(force = false) {
  const now = performance.now();

  if (!force && now - lastStateReport < 160) {
    return;
  }

  lastStateReport = now;
  const progress = maxScroll === 0 ? 0 : scrollY / maxScroll;

  window.electronAPI.sendCommand('state-update', {
    isPlaying,
    progress: clamp(progress, 0, 1),
    hasText,
    isAtEnd
  });
}

function resetToTop() {
  scrollY = 0;
  isPlaying = false;
  isAtEnd = false;
  endIndicator.hidden = true;
  lastTimestamp = null;
  applyTransform();
  reportState(true);
}

function setPlaying(nextState) {
  if (nextState && !hasText) {
    return;
  }

  if (nextState && isAtEnd) {
    scrollY = 0;
    isAtEnd = false;
    endIndicator.hidden = true;
    applyTransform();
  }

  isPlaying = Boolean(nextState);
  if (!isPlaying) {
    lastTimestamp = null;
  }

  reportState(true);
}

function setText(rawText) {
  const text = typeof rawText === 'string' ? rawText.replace(/\r/g, '') : '';
  const lines = text.split('\n');

  textTrack.innerHTML = '';
  hasText = text.trim().length > 0;

  if (!hasText) {
    emptyState.hidden = false;
    resetToTop();
    recomputeScrollLimits();
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const line of lines) {
    const paragraph = document.createElement('p');
    paragraph.textContent = line.trim().length > 0 ? line : ' ';
    fragment.appendChild(paragraph);
  }

  textTrack.appendChild(fragment);
  emptyState.hidden = true;
  resetToTop();
  recomputeScrollLimits();
}

function animationFrame(timestamp) {
  if (isPlaying && hasText) {
    if (lastTimestamp !== null) {
      const deltaSeconds = (timestamp - lastTimestamp) / 1000;
      scrollY += speed * deltaSeconds;

      if (scrollY >= maxScroll) {
        scrollY = maxScroll;
        isPlaying = false;
        isAtEnd = true;
        endIndicator.hidden = false;
        lastTimestamp = null;
        applyTransform();
        reportState(true);
        requestAnimationFrame(animationFrame);
        return;
      }

      applyTransform();
    }

    lastTimestamp = timestamp;
  } else {
    lastTimestamp = null;
  }

  reportState(false);
  requestAnimationFrame(animationFrame);
}

window.electronAPI.onCommand('play', () => {
  setPlaying(true);
});

window.electronAPI.onCommand('pause', () => {
  setPlaying(false);
});

window.electronAPI.onCommand('toggle-play', () => {
  setPlaying(!isPlaying);
});

window.electronAPI.onCommand('reset', () => {
  resetToTop();
});

window.electronAPI.onCommand('set-speed', (payload) => {
  speed = clamp(payload?.value, 0, 200);
});

window.electronAPI.onCommand('set-font-size', (payload) => {
  fontSize = clamp(payload?.value, 16, 72);
  applyStyles();
  recomputeScrollLimits();
});

window.electronAPI.onCommand('set-opacity', (payload) => {
  overlayOpacity = clamp(payload?.value, 0, 1);
  applyStyles();
});

window.electronAPI.onCommand('set-color', (payload) => {
  textColor = payload?.color || '#ffffff';
  applyStyles();
});

window.electronAPI.onCommand('toggle-mirror', (payload) => {
  mirrorMode = typeof payload?.value === 'boolean' ? payload.value : !mirrorMode;
  applyStyles();
});

window.electronAPI.onCommand('set-highlight', (payload) => {
  highlightLine = Boolean(payload?.value);
  applyStyles();
});

window.electronAPI.onCommand('set-movable', (payload) => {
  movableMode = Boolean(payload?.value);
  applyStyles();
});

window.electronAPI.onCommand('set-text', (payload) => {
  setText(payload?.text || '');
});

window.addEventListener('resize', () => {
  recomputeScrollLimits();
});

window.addEventListener('blur', () => {
  if (!movableMode) {
    window.electronAPI.disableMouse();
  }
});

dragHandle.addEventListener('mouseenter', () => {
  if (!movableMode) {
    window.electronAPI.enableMouse();
  }
});

dragHandle.addEventListener('mouseleave', () => {
  if (!movableMode) {
    window.electronAPI.disableMouse();
  }
});

(async () => {
  try {
    const initial = await window.electronAPI.getInitialState();

    speed = clamp(initial?.speed, 0, 200);
    fontSize = clamp(initial?.fontSize, 16, 72);
    overlayOpacity = clamp(initial?.opacity, 0, 1);
    textColor = initial?.textColor || '#ffffff';
    mirrorMode = Boolean(initial?.mirrorMode);
    highlightLine = Boolean(initial?.highlightLine);
    movableMode = Boolean(initial?.overlayMovable);

    applyStyles();
    setText(initial?.currentText || '');
  } catch (_error) {
    applyStyles();
    setText('');
  }

  requestAnimationFrame(animationFrame);
})();
