const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const Store = require('electron-store');

// ---------------------------------------------------------------------------
// Settings schema
//
// Every user-facing setting is declared here once, with its default value and
// a validator. Main process, control panel and teleprompter all consume the
// same validated object, so adding a setting is a one-line change here plus
// the UI that edits it.
// ---------------------------------------------------------------------------

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function num(min, max, def, { integer = false } = {}) {
  return {
    default: def,
    validate(value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return def;
      }
      const clamped = Math.min(max, Math.max(min, parsed));
      return integer ? Math.round(clamped) : clamped;
    }
  };
}

function bool(def) {
  return {
    default: def,
    validate(value) {
      return typeof value === 'boolean' ? value : def;
    }
  };
}

function oneOf(options, def) {
  const allowed = new Set(options);
  return {
    default: def,
    validate(value) {
      return allowed.has(value) ? value : def;
    }
  };
}

function color(def) {
  return {
    default: def,
    validate(value) {
      const str = String(value || '').trim();
      return HEX_COLOR.test(str) ? str.toLowerCase() : def;
    }
  };
}

function shortString(def, maxLength = 512) {
  return {
    default: def,
    validate(value) {
      return typeof value === 'string' ? value.slice(0, maxLength) : def;
    }
  };
}

const SCHEMA = {
  // Playback
  speed: num(0, 300, 40, { integer: true }),
  countdown: num(0, 10, 3, { integer: true }),
  pauseMarkers: bool(true),

  // Appearance
  fontSize: num(14, 96, 30, { integer: true }),
  lineHeight: num(1.1, 2.2, 1.45),
  fontFamily: oneOf(['sans', 'serif', 'mono', 'rounded'], 'sans'),
  textAlign: oneOf(['left', 'center'], 'left'),
  textColor: color('#ffffff'),
  bgColor: color('#0d0f14'),
  opacity: num(0, 1, 0.78),
  mirrorMode: bool(false),
  highlightLine: bool(true),
  fadeEdges: bool(true),
  focusPosition: num(0.1, 0.9, 0.35),

  // Overlay window
  overlayMovable: bool(false),
  hoverControls: bool(true),

  // Privacy
  stealthMode: bool(true),
  stealthControl: bool(true),

  // Voice-reactive scrolling
  voiceMode: bool(false),
  voiceSensitivity: num(0, 100, 60, { integer: true }),
  voiceHoldMs: num(200, 3000, 800, { integer: true }),
  micDeviceId: shortString(''),
  releaseMicWhenPaused: bool(true),

  // System
  globalShortcuts: bool(true)
};

const SETTING_KEYS = Object.keys(SCHEMA);

function defaultSettings() {
  const out = {};
  for (const key of SETTING_KEYS) {
    out[key] = SCHEMA[key].default;
  }
  return out;
}

// The app used to be called LensPrompt (package name "lens-prompt"). Carry its
// settings and last script over once so upgrading users don't start blank.
function migrateLegacyConfig() {
  try {
    const target = path.join(app.getPath('userData'), 'config.json');
    if (fs.existsSync(target)) {
      return;
    }

    for (const legacyName of ['lens-prompt', 'LensPrompt']) {
      const legacy = path.join(app.getPath('appData'), legacyName, 'config.json');
      if (!fs.existsSync(legacy)) {
        continue;
      }

      const data = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      // The old default window was much larger; start with the new compact one.
      delete data.windowBounds;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(data, null, 2));
      return;
    }
  } catch (error) {
    console.warn('[settings] legacy migration skipped:', error);
  }
}

migrateLegacyConfig();

const store = new Store({
  defaults: {
    ...defaultSettings(),
    lastInlineText: '',
    windowBounds: null,
    scripts: []
  }
});

function validateSetting(key, value) {
  const entry = SCHEMA[key];
  return entry ? entry.validate(value) : undefined;
}

function loadSettings() {
  const out = {};
  for (const key of SETTING_KEYS) {
    out[key] = validateSetting(key, store.get(key));
  }
  return out;
}

module.exports = {
  store,
  SCHEMA,
  SETTING_KEYS,
  validateSetting,
  loadSettings,
  defaultSettings
};
