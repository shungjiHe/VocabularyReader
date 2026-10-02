const CACHE_LIMIT = 8;
const PIPER_DEFAULT_VOICE = 'en_US-lessac-medium';
const PIPER_VOICES = [
  { id: 'en_US-lessac-medium', label: 'US English · Lessac medium' },
  { id: 'en_US-hfc_female-medium', label: 'US English · HFC female' },
  { id: 'en_US-hfc_male-medium', label: 'US English · HFC male' },
  { id: 'en_GB-cori-medium', label: 'British English · Cori medium' },
  { id: 'en_GB-alan-medium', label: 'British English · Alan medium' },
];

export class PiperAudioNotEnabledError extends Error {
  constructor(message = 'Piper audio is not enabled. Tap Enable Piper Audio first.') {
    super(message);
    this.name = 'NotAllowedError';
    this.code = 'PIPER_AUDIO_NOT_ENABLED';
  }
}

export function isPiperAudioBlocked(error) {
  return error?.code === 'PIPER_AUDIO_NOT_ENABLED' || error?.name === 'NotAllowedError';
}

function createAudioError(message, originalError, code) {
  const error = new Error(message);
  error.name = originalError?.name || 'PiperAudioPlaybackError';
  error.code = code;
  error.cause = originalError;
  return error;
}

function readWav(blob) {
  return blob.arrayBuffer().then((arrayBuffer) => {
    const view = new DataView(arrayBuffer);
    if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
      throw new Error('Piper returned an unsupported audio format.');
    }
    const channels = view.getUint16(22, true);
    const sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);
    if (channels !== 1 || bitsPerSample !== 16) throw new Error('Piper returned a non-PCM16 WAV.');
    let offset = 12;
    let dataOffset = -1;
    let dataLength = 0;
    while (offset + 8 <= view.byteLength) {
      const size = view.getUint32(offset + 4, true);
      if (view.getUint32(offset, false) === 0x64617461) {
        dataOffset = offset + 8;
        dataLength = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (dataOffset < 0) throw new Error('Piper WAV has no audio data.');
    return { bytes: new Uint8Array(arrayBuffer, dataOffset, dataLength), sampleRate };
  });
}

async function joinWavBlobs(blobs) {
  const parts = await Promise.all(blobs.map(readWav));
  const sampleRate = parts[0].sampleRate;
  if (parts.some((part) => part.sampleRate !== sampleRate)) throw new Error('Piper returned mismatched sample rates.');
  const dataLength = parts.reduce((total, part) => total + part.bytes.length, 0);
  const buffer = new ArrayBuffer(44 + dataLength);
  const output = new Uint8Array(buffer);
  const first = new Uint8Array(await blobs[0].arrayBuffer());
  output.set(first.slice(0, 44), 0);
  const view = new DataView(buffer);
  view.setUint32(4, 36 + dataLength, true);
  view.setUint32(40, dataLength, true);
  let offset = 44;
  for (const part of parts) {
    output.set(part.bytes, offset);
    offset += part.bytes.length;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export class PiperTtsEngine {
  constructor({ onStatus = () => {} } = {}) {
    this.onStatus = onStatus;
    this.piper = null;
    this.loadPromise = null;
    this.audioContext = null;
    this.audioUnlocked = false;
    this.audioElement = null;
    this.audio = null;
    this.sourceNode = null;
    this.pendingPlayback = null;
    this.playbackStartedAt = 0;
    this.operationId = 0;
    this.cancelled = false;
    this.cache = new Map();
  }

  async init() {
    if (this.piper) return this;
    if (!this.loadPromise) this.loadPromise = import('@diffusionstudio/vits-web');
    try {
      this.piper = await this.loadPromise;
      this.onStatus({ key: 'ready', label: 'Piper engine ready', detail: 'WASM VITS runtime' });
      return this;
    } catch (error) {
      this.loadPromise = null;
      throw error;
    }
  }

  isReady() { return Boolean(this.piper); }

  getVoices() { return PIPER_VOICES.map((voice) => ({ name: voice.id, label: voice.label })); }

  getAudioContext() {
    if (this.audioContext || typeof window === 'undefined') return this.audioContext;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    this.audioContext = new AudioContextClass();
    return this.audioContext;
  }

  isAudioReady() {
    const context = this.audioContext;
    return context ? this.audioUnlocked && context.state === 'running' : this.audioUnlocked;
  }

  getAudioElement() {
    if (this.audioElement || typeof document === 'undefined') return this.audioElement;
    const audio = document.createElement('audio');
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    audio.style.display = 'none';
    document.body?.appendChild(audio);
    this.audioElement = audio;
    return audio;
  }

  async enableAudio() {
    this.onStatus({ key: 'enabling', label: 'Enabling Piper audio', detail: 'Waiting for the iOS audio session' });
    try {
      const context = this.getAudioContext();
      if (!context) throw new PiperAudioNotEnabledError('This browser has no Web Audio API.');
      await context.resume();
      if (context.state !== 'running') throw new PiperAudioNotEnabledError('iOS did not start the audio session. Tap Enable Piper Audio again.');
      const silentBuffer = context.createBuffer(1, 1, context.sampleRate);
      const source = context.createBufferSource();
      source.buffer = silentBuffer;
      source.connect(context.destination);
      source.start(0);
      source.onended = () => source.disconnect();
      this.audioUnlocked = true;
      this.onStatus({ key: 'ready', label: 'Piper audio enabled', detail: 'Ready to load the voice on Play.' });
      return this;
    } catch (error) {
      this.audioUnlocked = false;
      const normalized = error instanceof PiperAudioNotEnabledError
        ? error
        : new PiperAudioNotEnabledError(error?.message || 'iOS blocked audio activation.');
      this.onStatus({ key: 'blocked', label: 'Playback blocked by iOS', detail: normalized.message });
      throw normalized;
    }
  }

  prepareForPlayback() { return this.isAudioReady(); }

  assertAudioReady() {
    if (!this.isAudioReady()) throw new PiperAudioNotEnabledError();
  }

  cacheKey(text, voice, speed) { return JSON.stringify([text, voice, Number(speed).toFixed(2)]); }

  addToCache(key, blob) {
    const entry = { url: URL.createObjectURL(blob), blob, audioBuffer: null };
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > CACHE_LIMIT) {
      const oldestKey = this.cache.keys().next().value;
      const oldest = this.cache.get(oldestKey);
      if (oldest?.url) URL.revokeObjectURL(oldest.url);
      this.cache.delete(oldestKey);
    }
    return entry;
  }

  async generateBlob(text, voice, index, total) {
    const progress = (info) => {
      const percent = info.total ? Math.round((info.loaded / info.total) * 100) : 0;
      this.onStatus({ key: 'loading', label: 'Downloading Piper voice', detail: `Voice ${index + 1} of ${total}`, progress: percent });
    };
    return this.piper.predict({ text, voiceId: voice }, progress);
  }

  async getAudioEntry(text, voice, speed, segments = [], operationId = this.operationId) {
    const key = this.cacheKey(text, voice, speed);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const articleSegments = segments.filter((segment) => String(segment).trim());
    let blob;
    if (articleSegments.length > 1) {
      const blobs = [];
      for (let index = 0; index < articleSegments.length; index += 1) {
        if (this.cancelled || operationId !== this.operationId) return null;
        this.onStatus({ key: 'generating', label: 'Generating Piper audio', detail: `Sentence ${index + 1} of ${articleSegments.length}`, progress: Math.round((index / articleSegments.length) * 100) });
        blobs.push(await this.generateBlob(articleSegments[index], voice, index, articleSegments.length));
      }
      this.onStatus({ key: 'generating', label: 'Preparing full article', detail: 'Joining continuous audio', progress: 100 });
      blob = await joinWavBlobs(blobs);
    } else {
      this.onStatus({ key: 'generating', label: 'Generating Piper audio', detail: 'Creating local speech' });
      blob = await this.generateBlob(text, voice, 0, 1);
    }
    return this.addToCache(key, blob);
  }

  async decodeAudio(entry) {
    const context = this.getAudioContext();
    if (!context) return null;
    if (!entry.audioBuffer) {
      try { entry.audioBuffer = await context.decodeAudioData((await entry.blob.arrayBuffer()).slice(0)); }
      catch (error) { throw createAudioError('The Piper WAV could not be decoded.', error, 'PIPER_AUDIO_DECODE_ERROR'); }
    }
    return entry.audioBuffer;
  }

  startBufferSource() {
    const playback = this.pendingPlayback;
    const context = this.audioContext;
    if (!playback || !context) return;
    if (context.state !== 'running') throw new PiperAudioNotEnabledError();
    const source = context.createBufferSource();
    source.buffer = playback.buffer;
    source.playbackRate.value = playback.rate;
    source.connect(context.destination);
    this.sourceNode = source;
    this.playbackStartedAt = context.currentTime;
    source.onended = () => {
      if (this.sourceNode !== source) return;
      this.sourceNode = null;
      source.disconnect();
      const finished = this.pendingPlayback;
      this.pendingPlayback = null;
      if (finished && !this.cancelled) finished.resolve();
    };
    source.start(0, Math.min(playback.offset, Math.max(0, playback.buffer.duration - 0.001)));
    this.onStatus({ key: 'playing', label: 'Playing', detail: 'Piper local voice · Web Audio' });
  }

  async playWithWebAudio(entry, rate) {
    const buffer = await this.decodeAudio(entry);
    if (!buffer) return this.playWithHtmlAudio(entry, rate);
    return new Promise((resolve, reject) => {
      this.pendingPlayback = { resolve, reject, mode: 'web-audio', buffer, offset: 0, rate: Number(rate) || 1 };
      try { this.startBufferSource(); } catch (error) { this.pendingPlayback = null; reject(error); }
    });
  }

  playWithHtmlAudio(entry, rate) {
    const audio = this.getAudioElement() || new Audio();
    audio.src = entry.url;
    audio.playbackRate = Number(rate) || 1;
    audio.load();
    this.audio = audio;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        this.audio = null;
        this.pendingPlayback = null;
        callback(value);
      };
      audio.onended = () => finish(resolve);
      audio.onerror = () => finish(reject, createAudioError('The Piper audio could not be played.', audio.error, 'PIPER_AUDIO_PLAYBACK_ERROR'));
      this.pendingPlayback = { mode: 'html', audio, resolve, reject };
      Promise.resolve(audio.play()).then(() => this.onStatus({ key: 'playing', label: 'Playing', detail: 'Piper local voice · HTML audio' })).catch((error) => finish(reject, isPiperAudioBlocked(error) ? error : createAudioError(`Audio play failed: ${error?.message || error?.name || 'unknown error'}`, error, 'PIPER_AUDIO_PLAYBACK_ERROR')));
    });
  }

  async speak(text, { voiceName = PIPER_DEFAULT_VOICE, rate = 1, segments = [] } = {}) {
    this.stop();
    const operationId = ++this.operationId;
    this.cancelled = false;
    this.assertAudioReady();
    await this.init();
    const entry = await this.getAudioEntry(text, voiceName, rate, segments, operationId);
    if (!entry || this.cancelled || operationId !== this.operationId) return;
    try { return await this.playWithWebAudio(entry, rate); }
    catch (error) {
      if (isPiperAudioBlocked(error)) throw error;
      this.onStatus({ key: 'error', label: 'Web Audio failed', detail: error.message });
      this.assertAudioReady();
      return this.playWithHtmlAudio(entry, rate);
    }
  }

  pause() {
    if (this.sourceNode && this.pendingPlayback?.mode === 'web-audio') {
      const elapsed = Math.max(0, this.audioContext.currentTime - this.playbackStartedAt) * this.pendingPlayback.rate;
      this.pendingPlayback.offset = Math.min(this.pendingPlayback.buffer.duration, this.pendingPlayback.offset + elapsed);
      this.sourceNode.onended = null;
      this.sourceNode.stop();
      this.sourceNode.disconnect();
      this.sourceNode = null;
      this.onStatus({ key: 'paused', label: 'Paused', detail: 'Piper Web Audio' });
    } else if (this.audio) {
      this.audio.pause();
      this.onStatus({ key: 'paused', label: 'Paused', detail: 'Piper HTML audio' });
    }
  }

  async resume() {
    if (this.pendingPlayback?.mode === 'web-audio' && !this.sourceNode) {
      try {
        if (this.audioContext.state !== 'running') await this.audioContext.resume();
        if (this.audioContext.state !== 'running') throw new PiperAudioNotEnabledError();
        this.startBufferSource();
      } catch (error) {
        this.pendingPlayback?.reject(error);
      }
    } else if (this.audio) {
      Promise.resolve(this.audio.play()).then(() => this.onStatus({ key: 'playing', label: 'Playing', detail: 'Piper HTML audio' })).catch((error) => this.pendingPlayback?.reject(error));
    }
  }

  stop() {
    this.cancelled = true;
    this.operationId += 1;
    if (this.sourceNode) {
      this.sourceNode.onended = null;
      try { this.sourceNode.stop(); } catch { /* already ended */ }
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio = null;
    }
    const pending = this.pendingPlayback;
    this.pendingPlayback = null;
    pending?.resolve?.();
    this.onStatus({ key: 'stopped', label: 'Stopped' });
  }

  clearCache() {
    for (const entry of this.cache.values()) URL.revokeObjectURL(entry.url);
    this.cache.clear();
  }
}

export { CACHE_LIMIT, PIPER_DEFAULT_VOICE, PIPER_VOICES };
