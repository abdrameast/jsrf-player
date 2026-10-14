/**
 * A single feature bus for every visual. YouTube audio is cross-origin: AUTO is
 * deliberately synthetic; LIVE/MIC analyse only an explicitly shared stream.
 * Capture sources are NEVER connected to the speakers. Only optional UI SFX are.
 */
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const mix = (a, b, t) => a + (b - a) * t;
const fract = (value) => value - Math.floor(value);
const smoothstep = (value) => value * value * (3 - 2 * value);
const hash = (value) => fract(Math.sin(value * 127.1 + 311.7) * 43758.5453);
const noise = (value) => mix(hash(Math.floor(value)), hash(Math.floor(value) + 1), smoothstep(fract(value)));
const follow = (current, target, dt, attack = 0.035, release = 0.2) =>
  mix(current, target, 1 - Math.exp(-dt / (target > current ? attack : release)));

export class AudioEngine extends EventTarget {
  constructor(config = {}) {
    super();
    this.config = config;
    this.mode = 'AUTO';
    this.features = {
      level: 0, bass: 0, lowMid: 0, mid: 0, high: 0,
      beat: 0, kick: 0,
      spectrum: new Float32Array(64),
      // Waveform is the usual signed audio signal; all energy values are 0–1.
      waveform: new Float32Array(256),
      bpm: Number(config.audio?.bpm) || 120,
    };
    this.context = null;
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this._captureToken = 0;
    this._captureListeners = [];
    this._lastPlayback = { time: 0, videoId: '', playing: false };
    this._lastAutoTime = NaN;
    this._lastAutoBpm = NaN;
    this._trackId = null;
    this._tapTimes = [];
    this._tempos = new Map();
    this._bandPeaks = new Float32Array(64).fill(0.004);
    this._energyPeaks = new Float32Array(5).fill(0.025);
    this._spectrumTargets = new Float32Array(64);
    this._energyTargets = new Float32Array(5);
    this._fluxValues = new Float32Array(256);
    this._fluxTimes = new Float64Array(256);
    this._fluxHead = 0;
    this._fluxCount = 0;
    this._fluxSum = 0;
    this._beatTimes = [];
    this._histogram = new Float32Array(241);
    this._lastBeatAt = -Infinity;
    this._bpmEstimate = this.features.bpm;
  }

  _notice(message, kind = 'info') {
    this.dispatchEvent(new CustomEvent('notice', { detail: { message, kind } }));
  }

  _setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this._lastAutoTime = NaN;
    this.dispatchEvent(new CustomEvent('modechange', { detail: { mode } }));
  }

  _getContext() {
    if (!this.context || this.context.state === 'closed') {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('Web Audio indisponible dans ce navigateur.');
      this.context = new AudioContextClass({ latencyHint: 'interactive' });
    }
    return this.context;
  }

  /** Call directly from the confirmation button, while user activation exists. */
  async startLive() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this._notice('Le partage audio d’onglet demande Chrome ou Edge sur ordinateur. Essaie MIC, ou garde AUTO.', 'info');
      return false;
    }
    return this._startCapture('LIVE', () => navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        suppressLocalAudioPlayback: false,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
    }));
  }

  /** MIC is an explicit alternative for browsers without tab audio sharing. */
  async startMic() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this._notice('Le microphone nécessite HTTPS ou localhost et un navigateur compatible. AUTO reste disponible.', 'error');
      return false;
    }
    return this._startCapture('MIC', () => navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    }));
  }

  async _startCapture(mode, request) {
    this.stopCapture();
    const token = this._captureToken;
    let stream;
    try {
      // Both permission request and context resume happen before the first await.
      const pendingStream = request();
      let context;
      try {
        context = this._getContext();
        context.resume().catch(() => {});
      } catch (error) {
        // If Web Audio fails while the picker is open, still close any later stream.
        pendingStream.then((result) => result.getTracks().forEach((track) => track.stop()), () => {});
        throw error;
      }
      stream = await pendingStream;
      if (token !== this._captureToken) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      const audioTracks = stream.getAudioTracks().filter((track) => track.readyState === 'live');
      if (!audioTracks.length) {
        stream.getTracks().forEach((track) => track.stop());
        this._notice(mode === 'LIVE'
          ? 'Aucun audio partagé. Choisis cet onglet et coche « Partager l’audio de l’onglet » dans la fenêtre du navigateur.'
          : 'Aucune piste audio du microphone. Vérifie le périphérique et ses autorisations.', 'info');
        return false;
      }
      this.stream = stream;
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.75;
      this.analyser.minDecibels = -100;
      this.analyser.maxDecibels = -15;
      this.source = context.createMediaStreamSource(new MediaStream(audioTracks));
      this.source.connect(this.analyser);
      // Keep the video track alive: stopping it also ends audio in some browsers.
      // No pixels are read, recorded, or sent anywhere.
      this._frequencyData = new Float32Array(this.analyser.frequencyBinCount);
      this._previousMagnitudes = new Float32Array(this.analyser.frequencyBinCount);
      this._waveData = new Float32Array(this.analyser.fftSize);
      this._initBands(context.sampleRate);
      this._resetDetector();
      for (const track of stream.getTracks()) {
        const ended = () => {
          if (this.stream !== stream) return;
          this.stopCapture();
          this._notice('La capture audio est terminée. Retour au mode AUTO.');
        };
        track.addEventListener('ended', ended);
        this._captureListeners.push([track, ended]);
      }
      this._setMode(mode);
      this._notice(mode === 'LIVE' ? 'LIVE connecté — les visuels suivent l’audio partagé.' : 'MIC connecté — les visuels suivent le microphone.');
      return true;
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (token !== this._captureToken) return false;
      this.stopCapture();
      const denied = error?.name === 'NotAllowedError' || error?.name === 'AbortError';
      this._notice(denied
        ? 'Capture annulée ou non autorisée. Le mode AUTO reste actif.'
        : mode === 'LIVE'
          ? 'Impossible de partager l’audio. Essaie un onglet Chrome/Edge avec son, ou choisis MIC.'
          : 'Impossible d’ouvrir le microphone. Vérifie qu’il est disponible et autorisé.', denied ? 'info' : 'error');
      return false;
    }
  }

  stopCapture() {
    this._captureToken += 1;
    for (const [track, listener] of this._captureListeners) track.removeEventListener('ended', listener);
    this._captureListeners.length = 0;
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this._setMode('AUTO');
  }

  _initBands(sampleRate) {
    const resolution = sampleRate / this.analyser.fftSize;
    const ceiling = Math.min(18000, sampleRate * 0.48);
    const bin = (hz) => clamp(Math.round(hz / resolution), 1, this.analyser.frequencyBinCount - 1);
    this._bands = Array.from({ length: 64 }, (_, i) => {
      const start = bin(20 * Math.pow(ceiling / 20, i / 64));
      return [start, Math.max(start + 1, bin(20 * Math.pow(ceiling / 20, (i + 1) / 64)))];
    });
    this._energyBands = [[40, 150], [150, 500], [500, 2500], [2500, ceiling]].map(([a, b]) => [bin(a), Math.max(bin(a) + 1, bin(b))]);
    this._bassBins = [bin(40), Math.max(bin(40) + 1, bin(150))];
  }

  _resetDetector() {
    this._previousMagnitudes?.fill(0);
    this._bandPeaks.fill(0.004);
    this._energyPeaks.fill(0.025);
    this._fluxHead = 0;
    this._fluxCount = 0;
    this._fluxSum = 0;
    this._beatTimes.length = 0;
    this._histogram.fill(0);
    this._lastBeatAt = -Infinity;
    this.features.beat = this.features.kick = 0;
  }

  _playback(snapshot = {}) {
    const time = Number(snapshot.currentTime ?? snapshot.time ?? 0);
    const state = snapshot.state;
    const playing = snapshot.playing ?? snapshot.isPlaying ?? (state === 1 || state === 'playing' || state === 'PLAYING');
    return {
      time: Math.max(0, Number.isFinite(time) ? time : 0),
      videoId: snapshot.videoId ?? snapshot.id ?? snapshot.tracks?.[snapshot.index]?.id ?? '',
      playing: Boolean(playing),
    };
  }

  /** Reuses arrays and the feature object so the render loop allocates no buffers. */
  update(dt = 1 / 60, playbackSnapshot = {}) {
    dt = clamp(Number(dt) || 1 / 60, 0.001, 0.25);
    const playback = this._playback(playbackSnapshot);
    if (playback.videoId !== this._trackId) {
      this._trackId = playback.videoId;
      this._tapTimes.length = 0;
      this._lastAutoTime = NaN;
      this._bpmEstimate = this._tempoFor(playback.videoId).bpm;
      if (this.mode !== 'AUTO') this._resetDetector();
    }
    this._lastPlayback = playback;
    if (this.analyser && this.mode !== 'AUTO') this._updateFFT(dt);
    else this._updateAuto(playback);
    return this.features;
  }

  _tempoFor(videoId) {
    const manual = this._tempos.get(videoId);
    if (manual) return manual;
    const table = this.config.trackBpm || this.config.audio?.trackBpm || {};
    const configured = table[videoId];
    return {
      bpm: clamp(Number(configured && typeof configured === 'object' ? configured.bpm : configured) || Number(this.config.audio?.bpm) || 120, 40, 240),
      phase: Number(configured && typeof configured === 'object' ? configured.phase : 0) || 0,
    };
  }

  _updateAuto(playback) {
    const { bpm, phase } = this._tempoFor(playback.videoId);
    const features = this.features;
    features.bpm = bpm;
    // Playback time is the clock: pausing also freezes every synthetic feature.
    if (playback.time === this._lastAutoTime && bpm === this._lastAutoBpm) return;
    // Initial idle state is quiet. Seeks in a paused, already-started track still
    // update the musical position without making the paused clock advance.
    if (!playback.playing && playback.time === 0 && !Number.isFinite(this._lastAutoTime)) {
      features.level = features.bass = features.lowMid = features.mid = features.high = 0;
      features.beat = features.kick = 0;
      features.spectrum.fill(0);
      features.waveform.fill(0);
      return;
    }
    this._lastAutoTime = playback.time;
    this._lastAutoBpm = bpm;
    const time = playback.time;
    const beatDuration = 60 / bpm;
    const beatPosition = (time - phase) / beatDuration;
    const beatPhase = fract(beatPosition);
    const section = Math.floor(beatPosition / 32); // Eight measures of 4/4.
    const sectionMix = smoothstep(clamp(fract(beatPosition / 32) * 32));
    const energy = mix(0.55 + hash(section - 1) * 0.37, 0.55 + hash(section) * 0.37, sectionMix);
    const kick = Math.exp(-beatPhase * beatDuration / 0.18);
    const hat = Math.exp(-fract(beatPosition + 0.5) * beatDuration / 0.065);
    const snare = Math.exp(-fract((beatPosition - 1) / 2) * beatDuration * 2 / 0.11);
    const phrase = noise(time * 0.78 + 3.5);
    features.beat = Math.exp(-beatPhase * beatDuration / 0.055);
    features.kick = kick;
    features.bass = clamp((0.12 + kick * 0.82) * energy);
    features.lowMid = clamp((0.19 + kick * 0.28 + phrase * 0.27) * energy);
    features.mid = clamp((0.19 + snare * 0.41 + noise(time * 2.1) * 0.28) * energy);
    features.high = clamp((0.1 + hat * 0.65 + noise(time * 4.3) * 0.16) * energy);
    features.level = clamp(features.bass * 0.33 + features.lowMid * 0.2 + features.mid * 0.3 + features.high * 0.17);
    for (let i = 0; i < 64; i++) {
      const region = i / 63;
      const band = region < 0.29 ? features.bass : region < 0.48 ? features.lowMid : region < 0.73 ? features.mid : features.high;
      const shape = 0.5 + 0.5 * noise(i * 0.63 + time * (0.18 + region * 0.23));
      features.spectrum[i] = clamp(band * shape * (0.65 + 0.35 * Math.sin(region * Math.PI)));
    }
    for (let i = 0; i < 256; i++) {
      const position = i / 256;
      features.waveform[i] = clamp(
        Math.sin(position * Math.PI * 8 + time * 11) * features.bass * 0.55
        + Math.sin(position * Math.PI * 26 - time * 15) * features.mid * 0.3
        + Math.sin(position * Math.PI * 71 + time * 23) * features.high * 0.15,
        -1, 1,
      );
    }
  }

  _updateFFT(dt) {
    const features = this.features;
    const now = this.context.currentTime;
    const frequencies = this._frequencyData;
    this.analyser.getFloatFrequencyData(frequencies);
    this.analyser.getFloatTimeDomainData(this._waveData);
    let rms = 0;
    for (let i = 0; i < this._waveData.length; i++) rms += this._waveData[i] ** 2;
    rms = Math.sqrt(rms / this._waveData.length);
    // A small real-signal gate prevents adaptive gain from amplifying silence.
    const gate = clamp((rms - 0.00012) / 0.0018);
    let bassFlux = 0;
    const [bassStart, bassEnd] = this._bassBins;
    for (let i = 0; i < frequencies.length; i++) {
      const magnitude = Number.isFinite(frequencies[i]) ? Math.pow(10, frequencies[i] / 20) : 0;
      if (i >= bassStart && i < bassEnd) bassFlux += Math.max(0, magnitude - this._previousMagnitudes[i]);
      this._previousMagnitudes[i] = magnitude;
      frequencies[i] = magnitude;
    }
    bassFlux /= bassEnd - bassStart;
    const bandEnergy = (start, end) => {
      let sum = 0;
      for (let i = start; i < end; i++) sum += frequencies[i] ** 2;
      return Math.sqrt(sum / (end - start));
    };
    const decay = Math.exp(-dt / 8);
    for (let i = 0; i < 64; i++) {
      const energy = bandEnergy(...this._bands[i]);
      const peak = this._bandPeaks[i] = Math.max(energy, this._bandPeaks[i] * decay, 0.002);
      this._spectrumTargets[i] = clamp(Math.sqrt(energy / peak) * gate);
      features.spectrum[i] = follow(features.spectrum[i], this._spectrumTargets[i], dt, 0.025, 0.2);
    }
    this._energyTargets[0] = rms;
    for (let i = 0; i < 4; i++) this._energyTargets[i + 1] = bandEnergy(...this._energyBands[i]);
    const keys = ['level', 'bass', 'lowMid', 'mid', 'high'];
    for (let i = 0; i < keys.length; i++) {
      const raw = this._energyTargets[i];
      const peak = this._energyPeaks[i] = Math.max(raw, this._energyPeaks[i] * decay, i === 0 ? 0.04 : 0.003);
      const normalized = clamp(Math.sqrt(raw / peak) * gate);
      features[keys[i]] = follow(features[keys[i]], normalized, dt);
    }
    // Peak-normalize the oscilloscope with the same slow gain adaptation.
    const waveGain = Math.min(7, 0.55 / Math.max(this._energyPeaks[0] * 2.5, 0.08));
    for (let i = 0; i < 256; i++) features.waveform[i] = clamp(this._waveData[i * 8] * waveGain, -1, 1);
    features.beat *= Math.exp(-dt / 0.055);
    features.kick *= Math.exp(-dt / 0.18);
    this._detectBeat(bassFlux, now, dt, gate);
    features.bpm = Math.round(this._bpmEstimate);
  }

  _detectBeat(flux, now, dt, gate) {
    // A one-second rolling mean, compared BEFORE the current onset is included.
    const capacity = this._fluxValues.length;
    while (this._fluxCount && now - this._fluxTimes[this._fluxHead] > 1) {
      this._fluxSum -= this._fluxValues[this._fluxHead];
      this._fluxHead = (this._fluxHead + 1) % capacity;
      this._fluxCount--;
    }
    const baseline = Math.max(0.00001, this._fluxSum / Math.max(this._fluxCount, 1));
    const onset = this._fluxCount > 6 && flux > baseline * 1.4 && gate > 0.15 && now - this._lastBeatAt >= 0.15;
    if (this._fluxCount === capacity) {
      this._fluxSum -= this._fluxValues[this._fluxHead];
      this._fluxHead = (this._fluxHead + 1) % capacity;
      this._fluxCount--;
    }
    const tail = (this._fluxHead + this._fluxCount) % capacity;
    this._fluxValues[tail] = flux;
    this._fluxTimes[tail] = now;
    this._fluxCount++;
    this._fluxSum += flux;
    const histogramDecay = Math.exp(-dt / 16);
    for (let i = 40; i <= 240; i++) this._histogram[i] *= histogramDecay;
    if (!onset) return;
    this._lastBeatAt = now;
    this.features.beat = 1;
    this.features.kick = clamp(0.5 + flux / (baseline * 8));
    // Several recent intervals tolerate occasional missed beats; octave folding
    // favours the useful 70–180 BPM range without claiming exact tempo analysis.
    for (let i = this._beatTimes.length - 1, distance = 1; i >= 0; i--, distance++) {
      const interval = now - this._beatTimes[i];
      if (interval <= 0) continue;
      let candidate = 60 / interval;
      while (candidate < 70) candidate *= 2;
      while (candidate > 180) candidate /= 2;
      const center = Math.round(candidate);
      for (let offset = -2; offset <= 2; offset++) {
        const index = clamp(center + offset, 40, 240);
        this._histogram[index] += Math.exp(-offset * offset / 2) / distance;
      }
    }
    this._beatTimes.push(now);
    if (this._beatTimes.length > 8) this._beatTimes.shift();
    if (this._beatTimes.length >= 4) {
      let winner = Math.round(clamp(this._bpmEstimate, 40, 240));
      for (let i = 40; i <= 240; i++) if (this._histogram[i] > this._histogram[winner]) winner = i;
      this._bpmEstimate = mix(this._bpmEstimate, winner, 0.25);
    }
  }

  /** timeSeconds is a monotonic wall clock; the phase uses the playback clock. */
  tapTempo(timeSeconds = performance.now() / 1000) {
    const last = this._tapTimes.at(-1);
    if (last !== undefined && timeSeconds - last < 0.18) return this.features.bpm;
    if (last !== undefined && timeSeconds - last > 2) this._tapTimes.length = 0;
    this._tapTimes.push(timeSeconds);
    if (this._tapTimes.length > 8) this._tapTimes.shift();
    let bpm = this._tempoFor(this._lastPlayback.videoId).bpm;
    if (this._tapTimes.length > 1) {
      const intervals = this._tapTimes.slice(1).map((time, index) => time - this._tapTimes[index]).sort((a, b) => a - b);
      const trimmed = intervals.length > 4 ? intervals.slice(1, -1) : intervals;
      bpm = Math.round(clamp(60 / (trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length), 40, 240));
    }
    this._tempos.set(this._lastPlayback.videoId, { bpm, phase: this._lastPlayback.time });
    this._lastAutoTime = NaN;
    this._bpmEstimate = bpm;
    this._histogram.fill(0);
    this._histogram[Math.round(bpm)] = 8;
    this.features.bpm = bpm;
    this._notice(this._tapTimes.length > 1 ? `Tempo calé à ${bpm} BPM.` : 'Continue de taper T sur les temps pour caler le tempo.');
    return bpm;
  }

  /** Optional, quiet, synthesized feedback. Invoke only on manual interaction. */
  sfx(kind = 'spray') {
    if (this.config.audio?.sfx === false) return;
    try {
      const context = this._getContext();
      if (context.state === 'suspended') context.resume().catch(() => {});
      const now = context.currentTime;
      const scratch = kind === 'scratch' || kind === 'track';
      const duration = scratch ? 0.095 : 0.13;
      const volume = clamp(Number(this.config.audio?.volume ?? 70) / 100);
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime((scratch ? 0.025 : 0.035) * volume, now + 0.006);
      envelope.gain.exponentialRampToValueAtTime(0.00001, now + duration);
      envelope.connect(context.destination);
      const filter = context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(scratch ? 1800 : 4300, now);
      filter.frequency.exponentialRampToValueAtTime(scratch ? 320 : 2800, now + duration);
      filter.Q.value = scratch ? 1.2 : 0.65;
      filter.connect(envelope);
      let source;
      if (scratch) {
        source = context.createOscillator();
        source.type = 'sawtooth';
        source.frequency.setValueAtTime(460, now);
        source.frequency.exponentialRampToValueAtTime(65, now + duration);
      } else {
        source = context.createBufferSource();
        const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
        const samples = buffer.getChannelData(0);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
        source.buffer = buffer;
      }
      source.connect(filter);
      source.onended = () => { source.disconnect(); filter.disconnect(); envelope.disconnect(); };
      source.start(now);
      source.stop(now + duration + 0.01);
    } catch {
      // SFX are decorative; unavailable Web Audio must not block playback.
    }
  }

  destroy() {
    this.stopCapture();
    if (this.context && this.context.state !== 'closed') this.context.close().catch(() => {});
  }
}
