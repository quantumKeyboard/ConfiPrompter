/* global window, navigator, AudioContext */

// ---------------------------------------------------------------------------
// VoiceDetector — offline, energy-based voice activity detection.
//
// Mic-sharing guarantees:
//  * Capture is opened in the browser's normal shared mode. Nothing here asks
//    for exclusive access, so Zoom, Meet, Teams and browser tabs can use the
//    same microphone at the same time.
//  * echoCancellation / noiseSuppression / autoGainControl are all OFF.
//    Chromium's AGC can change the *system* input volume (which every other
//    app would then hear), and the echo canceller can switch the device into
//    "communications" mode, which ducks other audio on Windows. Raw capture
//    avoids both.
//  * The stream is never connected to the speakers and is fully released
//    (tracks stopped, AudioContext closed) whenever it's not needed.
//
// Detection: band-limited (120 Hz–4 kHz) RMS level compared against an
// adaptive noise floor. The floor uses "minimum statistics": the quietest
// level seen over the last few seconds. Speech always dips between syllables
// and words, so talking continuously never raises the floor, while a steady
// noise source (fan, AC, hum) becomes the new floor within ~3 s. A short
// attack time rejects clicks and key taps; a configurable hold time keeps
// scrolling through the gaps between words.
// ---------------------------------------------------------------------------

const MIN_DB = -90;
const ATTACK_SEC = 0.06;
const FLOOR_BLOCK_SEC = 0.25;
const FLOOR_WINDOW_BLOCKS = 12; // 3 s of history

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function smoothing(dtSec, tauSec) {
  return 1 - Math.exp(-dtSec / tauSec);
}

class VoiceDetector {
  constructor() {
    this.stream = null;
    this.context = null;
    this.analyser = null;
    this.buffer = null;
    this.startToken = 0;
    this.deviceId = '';

    this.status = 'off'; // off | starting | listening | error
    this.error = '';

    this.sensitivity = 60;
    this.holdMs = 800;

    this.noiseFloorDb = null;
    this.blockMins = [];
    this.blockMin = Infinity;
    this.blockElapsed = 0;
    this.levelDb = MIN_DB;
    this.thresholdDb = MIN_DB;
    this.aboveSec = 0;
    this.lastVoiceAt = -Infinity;
    this.speaking = false;
    this.lastUpdate = null;
  }

  get isOpen() {
    return this.status === 'listening' || this.status === 'starting';
  }

  configure({ sensitivity, holdMs }) {
    if (Number.isFinite(sensitivity)) {
      this.sensitivity = clamp(sensitivity, 0, 100);
    }
    if (Number.isFinite(holdMs)) {
      this.holdMs = clamp(holdMs, 100, 5000);
    }
  }

  async start(deviceId = '') {
    if (this.isOpen && deviceId === this.deviceId) {
      return;
    }
    if (this.isOpen) {
      this.stop();
    }

    const token = ++this.startToken;
    this.deviceId = deviceId;
    this.status = 'starting';
    this.error = '';

    try {
      const allowed = await window.electronAPI.invoke('request-mic-access');
      if (!allowed) {
        throw new Error('Microphone access was denied in system settings.');
      }

      const audio = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      };
      if (deviceId) {
        // `ideal`, not `exact`: if the saved device is gone, fall back to the
        // default mic instead of failing.
        audio.deviceId = { ideal: deviceId };
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });

      if (token !== this.startToken) {
        // stop() was called while we were waiting for the device.
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const context = new AudioContext({ latencyHint: 'interactive' });
      if (context.state === 'suspended') {
        await context.resume().catch(() => {});
      }

      const source = context.createMediaStreamSource(stream);
      const highpass = context.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 120;
      const lowpass = context.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 4000;
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;

      source.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(analyser);
      // Deliberately NOT connected to context.destination.

      for (const track of stream.getAudioTracks()) {
        track.addEventListener('ended', () => {
          if (this.stream === stream) {
            this.stop();
            this.status = 'error';
            this.error = 'Microphone was disconnected.';
          }
        });
      }

      this.stream = stream;
      this.context = context;
      this.analyser = analyser;
      this.buffer = new Float32Array(analyser.fftSize);
      this.resetFloor();
      this.lastUpdate = null;
      this.status = 'listening';
    } catch (error) {
      if (token !== this.startToken) {
        return;
      }
      this.releaseResources();
      this.status = 'error';
      this.error = describeMediaError(error);
    }
  }

  stop() {
    this.startToken += 1;
    this.releaseResources();
    this.status = 'off';
    this.error = '';
  }

  releaseResources() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
    }
    if (this.context) {
      this.context.close().catch(() => {});
    }

    this.stream = null;
    this.context = null;
    this.analyser = null;
    this.buffer = null;
    this.speaking = false;
    this.levelDb = MIN_DB;
    this.aboveSec = 0;
    this.lastVoiceAt = -Infinity;
  }

  // Call once per animation frame. Returns true while speech is detected
  // (including the hold period after the last syllable).
  update(nowMs) {
    if (!this.analyser || this.status !== 'listening') {
      this.speaking = false;
      return false;
    }

    const dt = this.lastUpdate === null ? 1 / 60 : clamp((nowMs - this.lastUpdate) / 1000, 0.001, 0.25);
    this.lastUpdate = nowMs;

    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (let i = 0; i < this.buffer.length; i += 1) {
      sum += this.buffer[i] * this.buffer[i];
    }
    const rms = Math.sqrt(sum / this.buffer.length);
    const db = clamp(20 * Math.log10(rms + 1e-10), MIN_DB, 0);
    this.levelDb = db;

    // Minimum statistics over FLOOR_WINDOW_BLOCKS blocks.
    this.blockMin = Math.min(this.blockMin, db);
    this.blockElapsed += dt;
    if (this.blockElapsed >= FLOOR_BLOCK_SEC) {
      this.blockMins.push(this.blockMin);
      if (this.blockMins.length > FLOOR_WINDOW_BLOCKS) {
        this.blockMins.shift();
      }
      this.blockMin = Infinity;
      this.blockElapsed = 0;
    }
    const windowMin = Math.min(this.blockMin, ...this.blockMins);
    // RMS of steady noise fluctuates ~±2 dB around its mean, and the minimum
    // sits at the bottom of that range; nudge it back up.
    const floorEstimate = clamp(windowMin + 2, MIN_DB, -10);

    if (this.noiseFloorDb === null) {
      this.noiseFloorDb = floorEstimate;
    } else {
      // Follow quickly downwards, glide upwards.
      const tau = floorEstimate < this.noiseFloorDb ? 0.1 : 0.4;
      this.noiseFloorDb += (floorEstimate - this.noiseFloorDb) * smoothing(dt, tau);
    }

    // Sensitivity 0 → needs 24 dB over the noise floor, 100 → only 6 dB.
    const marginDb = 24 - (this.sensitivity / 100) * 18;
    this.thresholdDb = Math.max(this.noiseFloorDb + marginDb, -80);
    const isAbove = db > this.thresholdDb;

    this.aboveSec = isAbove ? this.aboveSec + dt : 0;
    if (this.aboveSec >= ATTACK_SEC) {
      this.lastVoiceAt = nowMs;
    }

    this.speaking = nowMs - this.lastVoiceAt < this.holdMs;
    return this.speaking;
  }

  resetFloor() {
    this.noiseFloorDb = null;
    this.blockMins = [];
    this.blockMin = Infinity;
    this.blockElapsed = 0;
  }

  snapshot() {
    const norm = (db) => clamp((db - MIN_DB) / -MIN_DB, 0, 1);
    return {
      status: this.status,
      error: this.error,
      speaking: this.speaking,
      level: norm(this.levelDb),
      threshold: norm(this.thresholdDb)
    };
  }
}

function describeMediaError(error) {
  const name = error && error.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission denied.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone found.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'Microphone is unavailable (another app may have exclusive access).';
  }
  return (error && error.message) || 'Could not open the microphone.';
}

window.VoiceDetector = VoiceDetector;
