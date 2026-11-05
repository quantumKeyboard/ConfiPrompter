/* global VoiceDetector */

const api = window.electronAPI;

const overlay = document.getElementById('overlay');
const viewport = document.getElementById('viewport');
const textTrack = document.getElementById('text-track');
const emptyState = document.getElementById('empty-state');
const countdownEl = document.getElementById('countdown');
const endIndicator = document.getElementById('end-indicator');
const voiceBadge = document.getElementById('voice-badge');
const voiceBadgeText = document.getElementById('voice-badge-text');
const progressFill = document.getElementById('progress-fill');
const toolbar = document.getElementById('toolbar');
const tbPlay = document.getElementById('tb-play');
const tbSpeed = document.getElementById('tb-speed');
const tbVoice = document.getElementById('tb-voice');
const tbMicLevel = document.getElementById('tb-mic-level');
const tbLock = document.getElementById('tb-lock');
const tbStealth = document.getElementById('tb-stealth');

const FONT_STACKS = {
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  serif: "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif",
  mono: "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  rounded: "'SF Pro Rounded', ui-rounded, 'Nunito', 'Varela Round', 'Segoe UI', system-ui, sans-serif"
};

const EDGE_HOT_ZONE = 8;
const TOOLBAR_HIDE_DELAY = 2200;

let settings = {
  speed: 40,
  countdown: 3,
  pauseMarkers: true,
  fontSize: 30,
  lineHeight: 1.45,
  fontFamily: 'sans',
  textAlign: 'left',
  textColor: '#ffffff',
  bgColor: '#0d0f14',
  opacity: 0.78,
  mirrorMode: false,
  highlightLine: true,
  fadeEdges: true,
  focusPosition: 0.35,
  overlayMovable: false,
  hoverControls: true,
  stealthMode: true,
  voiceMode: false,
  voiceSensitivity: 60,
  voiceHoldMs: 800,
  micDeviceId: '',
  releaseMicWhenPaused: true
};

// Scroll state -------------------------------------------------------------
let scrollY = 0;
let maxScroll = 0;
let velocity = 0;
let seekTarget = null;
let isPlaying = false;
let hasText = false;
let isAtEnd = false;
let countdownRemaining = 0;
let elapsedSec = 0;
let lastFrame = null;
let lastStateReport = 0;
let lastVoiceReport = 0;

// Layout caches (content-space y, i.e. the scrollY at which an element sits
// on the reading line)
let paragraphs = [];
let paragraphTops = [];
let pauseMarks = [];
let activeIndex = -1;

// Hover / pointer state ----------------------------------------------------
let hoverInteractive = false;
let lastPointerMove = 0;
let pointerInside = false;
let windowOpActive = false;

let stealthSupported = true;

// Voice ----------------------------------------------------------------------
const voice = new VoiceDetector();
let voicePreviewUntil = 0;

function clamp(value, min, max) {
  const n = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!match) {
    return '13, 15, 20';
  }
  const int = parseInt(match[1], 16);
  return `${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function applySettings() {
  const style = document.documentElement.style;
  style.setProperty('--font-size', `${settings.fontSize}px`);
  style.setProperty('--line-height', String(settings.lineHeight));
  style.setProperty('--text-color', settings.textColor);
  style.setProperty('--bg-rgb', hexToRgb(settings.bgColor));
  style.setProperty('--bg-alpha', String(settings.opacity));
  style.setProperty('--focus', String(settings.focusPosition));
  style.setProperty('--font-family', FONT_STACKS[settings.fontFamily] || FONT_STACKS.sans);
  style.setProperty('--text-align', settings.textAlign);

  overlay.classList.toggle('mirrored', settings.mirrorMode);
  overlay.classList.toggle('highlight', settings.highlightLine);
  overlay.classList.toggle('fade-edges', settings.fadeEdges);
  overlay.classList.toggle('is-movable', settings.overlayMovable);

  tbSpeed.textContent = String(settings.speed);
  tbVoice.classList.toggle('is-on', settings.voiceMode);
  tbLock.classList.toggle('is-on', settings.overlayMovable);
  tbStealth.classList.toggle('is-off', !settings.stealthMode || !stealthSupported);
  if (!stealthSupported) {
    tbStealth.title = 'Screen-share stealth is not supported on this OS';
  } else {
    tbStealth.title = settings.stealthMode ? 'Hidden from screen share' : 'Visible to screen share';
  }

  voice.configure({ sensitivity: settings.voiceSensitivity, holdMs: settings.voiceHoldMs });
  updateChrome();
}

// Inline markup: **bold** and [stage directions]
function appendInline(parent, line) {
  const pattern = /(\*\*[^*]+\*\*|\[[^\]]+\])/g;
  let last = 0;
  let match;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > last) {
      parent.appendChild(document.createTextNode(line.slice(last, match.index)));
    }

    const token = match[0];
    if (token.startsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    } else {
      const cue = document.createElement('span');
      cue.className = 'cue';
      cue.textContent = token;
      parent.appendChild(cue);
    }
    last = match.index + token.length;
  }

  if (last < line.length) {
    parent.appendChild(document.createTextNode(line.slice(last)));
  }
}

function renderText(rawText) {
  const text = typeof rawText === 'string' ? rawText.replace(/\r\n?/g, '\n') : '';
  hasText = text.trim().length > 0;
  textTrack.textContent = '';

  if (hasText) {
    const fragment = document.createDocumentFragment();

    for (const line of text.split('\n')) {
      const p = document.createElement('p');
      const trimmed = line.trim();

      if (!trimmed) {
        p.className = 'blank';
      } else if (/^\[\s*pause\s*\]$/i.test(trimmed)) {
        p.className = 'cue-pause';
        p.dataset.pause = '1';
        p.textContent = 'Pause';
      } else if (/^#{1,6}\s+/.test(trimmed)) {
        p.className = 'cue-heading';
        p.textContent = trimmed.replace(/^#{1,6}\s+/, '');
      } else {
        appendInline(p, line);
      }

      fragment.appendChild(p);
    }

    textTrack.appendChild(fragment);
  }

  emptyState.hidden = hasText;
  recomputeLayout();
}

function recomputeLayout() {
  const height = viewport.clientHeight;
  const padTop = Math.round(height * settings.focusPosition);
  const padBottom = height - padTop;
  textTrack.style.paddingTop = `${padTop}px`;
  textTrack.style.paddingBottom = `${padBottom}px`;

  maxScroll = Math.max(textTrack.scrollHeight - height, 0);

  paragraphs = Array.from(textTrack.children);
  paragraphTops = paragraphs.map((p) => p.offsetTop - padTop);
  pauseMarks = paragraphs
    .filter((p) => p.dataset.pause)
    .map((p) => ({ y: p.offsetTop - padTop, el: p }));

  scrollY = clamp(scrollY, 0, maxScroll);
  if (seekTarget !== null) {
    seekTarget = clamp(seekTarget, 0, maxScroll);
  }

  activeIndex = -1;
  applyTransform();
}

function applyTransform() {
  textTrack.style.transform = `translate3d(0, ${-scrollY}px, 0)`;
  progressFill.style.transform = `scaleX(${maxScroll ? scrollY / maxScroll : 0})`;
  updateActiveParagraph();
}

function indexAt(y) {
  // Last paragraph whose top is at or above the reading line.
  let lo = 0;
  let hi = paragraphTops.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (paragraphTops[mid] <= y) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function updateActiveParagraph() {
  if (!paragraphs.length) {
    return;
  }

  const lineHeightPx = settings.fontSize * settings.lineHeight;
  const next = indexAt(scrollY + lineHeightPx * 0.5);
  if (next === activeIndex) {
    return;
  }

  if (activeIndex >= 0 && paragraphs[activeIndex]) {
    paragraphs[activeIndex].classList.remove('is-active');
  }
  paragraphs[next].classList.add('is-active');
  activeIndex = next;
}

function updateChrome() {
  tbPlay.classList.toggle('is-playing', isPlaying || countdownRemaining > 0);
  endIndicator.hidden = !isAtEnd;

  const showToolbar =
    settings.overlayMovable ||
    (settings.hoverControls && (pointerInside || hoverInteractive) && performance.now() - lastPointerMove < TOOLBAR_HIDE_DELAY) ||
    toolbar.matches(':hover') ||
    windowOpActive;
  overlay.classList.toggle('show-toolbar', showToolbar);
  overlay.classList.toggle('show-grips', settings.overlayMovable || hoverInteractive);
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

function reportState(force = false) {
  const now = performance.now();
  if (!force && now - lastStateReport < 200) {
    return;
  }
  lastStateReport = now;

  const remainingPx = Math.max(maxScroll - scrollY, 0);
  api.sendCommand('state-update', {
    isPlaying,
    progress: maxScroll ? clamp(scrollY / maxScroll, 0, 1) : 0,
    hasText,
    isAtEnd,
    countdown: Math.ceil(countdownRemaining),
    remainingSec: settings.speed > 0 ? remainingPx / settings.speed : 0,
    elapsedSec
  });
}

function stopCountdown() {
  countdownRemaining = 0;
  countdownEl.hidden = true;
}

function resetToTop() {
  scrollY = 0;
  seekTarget = null;
  velocity = 0;
  isPlaying = false;
  isAtEnd = false;
  elapsedSec = 0;
  stopCountdown();
  for (const mark of pauseMarks) {
    mark.consumed = false;
  }
  applyTransform();
  updateChrome();
  reportState(true);
}

function setPlaying(next) {
  if (next && !hasText) {
    return;
  }

  if (next) {
    if (isAtEnd || scrollY >= maxScroll - 1) {
      resetToTop();
    }

    if (scrollY < 1 && settings.countdown > 0 && countdownRemaining <= 0) {
      countdownRemaining = settings.countdown;
      showCountdownNumber();
    }

    isPlaying = true;
  } else {
    isPlaying = false;
    velocity = 0;
    stopCountdown();
  }

  updateChrome();
  reportState(true);
}

function showCountdownNumber() {
  const value = Math.ceil(countdownRemaining);
  if (countdownEl.textContent !== String(value) || countdownEl.hidden) {
    countdownEl.hidden = false;
    countdownEl.textContent = String(value);
    countdownEl.classList.remove('tick');
    // Restart the CSS animation.
    void countdownEl.offsetWidth;
    countdownEl.classList.add('tick');
  }
}

function seekTo(y, { smooth = true } = {}) {
  const target = clamp(y, 0, maxScroll);
  isAtEnd = false;

  // Pause markers behind the new position are considered read; ones ahead
  // are re-armed.
  for (const mark of pauseMarks) {
    mark.consumed = mark.y < target - 1;
  }

  if (smooth) {
    seekTarget = target;
  } else {
    seekTarget = null;
    scrollY = target;
    applyTransform();
  }
  updateChrome();
  reportState(true);
}

function jump(direction) {
  if (!paragraphTops.length) {
    return;
  }

  const base = seekTarget ?? scrollY;
  const contentful = paragraphs
    .map((p, i) => ({ y: paragraphTops[i], blank: p.classList.contains('blank') }))
    .filter((item) => !item.blank);

  if (direction > 0) {
    const next = contentful.find((item) => item.y > base + 2);
    seekTo(next ? next.y : maxScroll);
  } else {
    const prev = [...contentful].reverse().find((item) => item.y < base - 2);
    seekTo(prev ? prev.y : 0);
  }
}

function micNeeded(now) {
  if (now < voicePreviewUntil) {
    return true;
  }
  if (!settings.voiceMode) {
    return false;
  }
  if (!settings.releaseMicWhenPaused) {
    return true;
  }
  return isPlaying || countdownRemaining > 0;
}

function syncMic(now) {
  const want = micNeeded(now);
  if (want && (!voice.isOpen || voice.deviceId !== settings.micDeviceId) && voice.status !== 'error') {
    voice.start(settings.micDeviceId);
  } else if (!want && (voice.isOpen || voice.status === 'error')) {
    voice.stop();
  }
}

function updateVoiceUi(now) {
  const snap = voice.snapshot();
  const showBadge = settings.voiceMode && (isPlaying || snap.status === 'error');
  voiceBadge.hidden = !showBadge;

  if (showBadge) {
    voiceBadge.classList.toggle('speaking', snap.speaking);
    voiceBadge.classList.toggle('error', snap.status === 'error');
    let label = 'Listening';
    if (snap.status === 'error') {
      label = 'Mic error';
    } else if (snap.status === 'starting') {
      label = 'Starting mic';
    } else if (snap.speaking) {
      label = 'Following you';
    }
    if (voiceBadgeText.textContent !== label) {
      voiceBadgeText.textContent = label;
    }
  }

  tbMicLevel.style.transform = `scaleY(${snap.level.toFixed(3)})`;

  if (now - lastVoiceReport > 80) {
    lastVoiceReport = now;
    api.sendCommand('voice-update', { ...snap, preview: now < voicePreviewUntil });
  }
}

function frame(now) {
  const dt = lastFrame === null ? 0 : Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  syncMic(now);
  const speaking = voice.update(now);

  if (countdownRemaining > 0 && isPlaying) {
    countdownRemaining -= dt;
    if (countdownRemaining <= 0) {
      stopCountdown();
    } else {
      showCountdownNumber();
    }
  }

  if (seekTarget !== null) {
    const diff = seekTarget - scrollY;
    if (Math.abs(diff) < 0.5) {
      scrollY = seekTarget;
      seekTarget = null;
    } else {
      scrollY += diff * (1 - Math.exp(-dt / 0.09));
    }
    applyTransform();
  } else if (isPlaying && hasText && countdownRemaining <= 0) {
    // In voice mode we only move while you're talking; velocity eases in and
    // out so starts and stops don't jerk.
    const target = settings.voiceMode ? (speaking ? settings.speed : 0) : settings.speed;
    const tau = target > velocity ? 0.25 : 0.18;
    velocity += (target - velocity) * (1 - Math.exp(-dt / tau));
    if (velocity > 0.05) {
      elapsedSec += dt;
    }

    const previous = scrollY;
    scrollY = Math.min(scrollY + velocity * dt, maxScroll);

    if (settings.pauseMarkers) {
      const hit = pauseMarks.find((mark) => !mark.consumed && mark.y > previous && mark.y <= scrollY);
      if (hit) {
        hit.consumed = true;
        scrollY = hit.y;
        applyTransform();
        setPlaying(false);
        lastFrame = now;
        requestAnimationFrame(frame);
        return;
      }
    }

    applyTransform();

    if (scrollY >= maxScroll) {
      isPlaying = false;
      isAtEnd = true;
      velocity = 0;
      updateChrome();
      reportState(true);
    }
  } else {
    velocity = 0;
  }

  updateVoiceUi(now);
  updateChrome();
  reportState(false);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Hover toolbar, click-through, move & resize
// ---------------------------------------------------------------------------

function setHoverInteractive(value) {
  if (value === hoverInteractive) {
    return;
  }
  hoverInteractive = value;
  api.sendCommand('set-hover-interactive', { value });
  updateChrome();
}

function inHotZone(x, y) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const nearEdge = x <= EDGE_HOT_ZONE || y <= EDGE_HOT_ZONE || x >= w - EDGE_HOT_ZONE || y >= h - EDGE_HOT_ZONE;
  if (nearEdge) {
    return true;
  }
  if (!settings.hoverControls) {
    return false;
  }
  const rect = toolbar.getBoundingClientRect();
  return x >= rect.left - 4 && x <= rect.right + 4 && y >= rect.top - 4 && y <= rect.bottom + 4;
}

// With setIgnoreMouseEvents(true, { forward: true }) the window still gets
// mousemove events, so we can make just the toolbar and edges clickable and
// leave the text area click-through.
document.addEventListener('mousemove', (event) => {
  lastPointerMove = performance.now();
  pointerInside = true;
  if (!windowOpActive) {
    setHoverInteractive(inHotZone(event.clientX, event.clientY));
  }
});

document.addEventListener('mouseleave', () => {
  pointerInside = false;
  if (!windowOpActive) {
    setHoverInteractive(false);
  }
});

function beginWindowOp(event, op, edge) {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  windowOpActive = true;
  event.currentTarget.setPointerCapture(event.pointerId);
  api.sendCommand('window-op-start', { op, edge });

  const target = event.currentTarget;
  const end = () => {
    windowOpActive = false;
    api.sendCommand('window-op-end');
    target.removeEventListener('pointerup', end);
    target.removeEventListener('pointercancel', end);
    target.removeEventListener('lostpointercapture', end);
    // Re-evaluate whether we should stay clickable.
    lastPointerMove = performance.now();
  };
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
  target.addEventListener('lostpointercapture', end);
}

for (const grip of document.querySelectorAll('.rz')) {
  grip.addEventListener('pointerdown', (event) => beginWindowOp(event, 'resize', grip.dataset.edge));
}

document.querySelector('.tb-grip').addEventListener('pointerdown', (event) => beginWindowOp(event, 'move'));

viewport.addEventListener('pointerdown', (event) => {
  if (settings.overlayMovable) {
    beginWindowOp(event, 'move');
  }
});

window.addEventListener('blur', () => {
  if (windowOpActive) {
    windowOpActive = false;
    api.sendCommand('window-op-end');
  }
});

toolbar.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) {
    return;
  }

  switch (button.dataset.action) {
    case 'toggle-play':
      setPlaying(!(isPlaying || countdownRemaining > 0));
      break;
    case 'speed-down':
      api.sendCommand('update-settings', { speed: settings.speed - 5 });
      break;
    case 'speed-up':
      api.sendCommand('update-settings', { speed: settings.speed + 5 });
      break;
    case 'font-down':
      api.sendCommand('update-settings', { fontSize: settings.fontSize - 2 });
      break;
    case 'font-up':
      api.sendCommand('update-settings', { fontSize: settings.fontSize + 2 });
      break;
    case 'toggle-voice':
      api.sendCommand('update-settings', { voiceMode: !settings.voiceMode });
      break;
    case 'toggle-lock':
      api.sendCommand('update-settings', { overlayMovable: !settings.overlayMovable });
      break;
    case 'show-control':
      api.sendCommand('show-control');
      break;
    case 'hide':
      api.sendCommand('toggle-prompter', { value: false });
      break;
    default:
      break;
  }
});

// Mouse wheel nudges the script when the overlay is interactive.
viewport.addEventListener(
  'wheel',
  (event) => {
    if (!hasText) {
      return;
    }
    event.preventDefault();
    seekTo((seekTarget ?? scrollY) + event.deltaY, { smooth: false });
  },
  { passive: false }
);

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLButtonElement && (event.key === ' ' || event.key === 'Enter')) {
    return;
  }

  const lineHeightPx = settings.fontSize * settings.lineHeight;
  switch (event.key) {
    case ' ':
      event.preventDefault();
      setPlaying(!(isPlaying || countdownRemaining > 0));
      break;
    case 'ArrowDown':
      seekTo((seekTarget ?? scrollY) + lineHeightPx);
      break;
    case 'ArrowUp':
      seekTo((seekTarget ?? scrollY) - lineHeightPx);
      break;
    case 'ArrowRight':
      jump(1);
      break;
    case 'ArrowLeft':
      jump(-1);
      break;
    case 'Home':
      resetToTop();
      break;
    case 'Escape':
      if (settings.overlayMovable) {
        api.sendCommand('update-settings', { overlayMovable: false });
      }
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

api.onCommand('settings-updated', (next) => {
  const layoutKeys = ['fontSize', 'lineHeight', 'fontFamily', 'focusPosition', 'textAlign'];
  const relayout = layoutKeys.some((key) => next[key] !== settings[key]);
  const progress = maxScroll ? scrollY / maxScroll : 0;

  settings = { ...settings, ...next };
  applySettings();

  if (relayout) {
    recomputeLayout();
    // Keep your place in the script when the text reflows.
    scrollY = clamp(progress * maxScroll, 0, maxScroll);
    applyTransform();
  }
});

api.onCommand('set-text', (payload) => {
  const progress = maxScroll ? scrollY / maxScroll : 0;
  renderText(payload?.text || '');

  if (payload?.reset) {
    resetToTop();
  } else {
    // Editing while paused: stay roughly where you were.
    scrollY = clamp(progress * maxScroll, 0, maxScroll);
    for (const mark of pauseMarks) {
      mark.consumed = mark.y < scrollY - 1;
    }
    applyTransform();
    reportState(true);
  }
});

api.onCommand('play', () => setPlaying(true));
api.onCommand('pause', () => setPlaying(false));
api.onCommand('toggle-play', () => setPlaying(!(isPlaying || countdownRemaining > 0)));
api.onCommand('reset', () => resetToTop());
api.onCommand('seek', (payload) => seekTo(clamp(payload?.progress, 0, 1) * maxScroll));
api.onCommand('jump', (payload) => jump(payload?.direction >= 0 ? 1 : -1));

api.onCommand('voice-preview', (payload) => {
  voicePreviewUntil = payload?.value ? performance.now() + 20_000 : 0;
  if (payload?.value && voice.status === 'error') {
    // Retry after an error when the user explicitly tests the mic.
    voice.stop();
  }
});

window.addEventListener('resize', () => {
  const progress = maxScroll ? scrollY / maxScroll : 0;
  recomputeLayout();
  scrollY = clamp(progress * maxScroll, 0, maxScroll);
  applyTransform();
});

// Retry the mic after an error when the user re-enables voice mode or
// presses play again.
let lastVoiceMode = settings.voiceMode;
api.onCommand('settings-updated', (next) => {
  if (next.voiceMode && !lastVoiceMode && voice.status === 'error') {
    voice.stop();
  }
  lastVoiceMode = next.voiceMode;
});
api.onCommand('play', () => {
  if (voice.status === 'error') {
    voice.stop();
  }
});

if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (voice.status === 'error') {
      voice.stop();
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async () => {
  try {
    const initial = await api.getInitialState();
    settings = { ...settings, ...(initial?.settings || {}) };
    stealthSupported = initial?.platform?.stealthSupported !== false;
    lastVoiceMode = settings.voiceMode;
    applySettings();
    renderText(initial?.currentText || '');
  } catch (_error) {
    applySettings();
    renderText('');
  }

  resetToTop();
  requestAnimationFrame(frame);
})();
