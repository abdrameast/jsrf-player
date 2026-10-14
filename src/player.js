/**
 * YouTube is the sole playback source. The iframe is created during startup;
 * play() deliberately stays synchronous to preserve the browser's user gesture.
 * No attempt is made to extract or analyse the cross-origin iframe's audio.
 */
const CACHE_PREFIX = 'grind-fm:metadata:v1:';
const BLOCKED_ERRORS = new Set([2, 5, 100, 101, 150]);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
let iframeAPI;

function loadIframeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (iframeAPI) return iframeAPI;

  iframeAPI = new Promise((resolve, reject) => {
    let settled = false;
    const previousCallback = window.onYouTubeIframeAPIReady;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        iframeAPI = null;
        reject(error);
      } else resolve(window.YT);
    };
    const timeout = setTimeout(() => finish(new Error(
      'YouTube ne répond pas. Vérifie ta connexion et autorise YouTube dans ton bloqueur de contenu.'
    )), 15000);

    window.onYouTubeIframeAPIReady = () => {
      // Preserve another embed's callback if this page gains additional players.
      try { previousCallback?.(); } catch { /* An unrelated embed must not block radio. */ }
      finish();
    };
    let script = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.referrerPolicy = 'strict-origin-when-cross-origin';
      document.head.append(script);
    }
    script.addEventListener('error', () => finish(new Error(
      'L’API YouTube est bloquée. Autorise youtube.com et youtube-nocookie.com dans ton bloqueur, puis recharge la page.'
    )), { once: true });
  });
  return iframeAPI;
}

/** Clean upload annotations without stripping meaningful mix/version names. */
function parseTitle(rawTitle) {
  const title = String(rawTitle || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:[^)]*\b(?:official|hq|hd|1080p|4k|ost|soundtrack|lyrics?|audio|video)\b[^)]*)\)/gi, ' ')
    .replace(/^(?:jet set radio future|jet set radio|jsrf)\s*(?:(?:complete|original)\s*)?(?:soundtrack|ost)?\s*[:–—-]?\s*/i, '')
    .replace(/^\d{1,2}\s*[.:–—-]\s*/, '')
    .replace(/\s*[|–—-]\s*(?:official\s*)?(?:audio|music video|video|lyrics?|hq|hd)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return { title: String(rawTitle || '').trim(), artist: '' };
  const pieces = title.split(/\s+[–—-]\s+/);
  return pieces.length > 1
    ? { artist: pieces.shift().trim(), title: pieces.join(' — ').trim() }
    : { title, artist: '' };
}

function cachedMetadata(id) {
  try {
    const item = JSON.parse(localStorage.getItem(CACHE_PREFIX + id) || 'null');
    if (item && typeof item.title === 'string' && item.title.trim()) {
      return { title: item.title, artist: typeof item.artist === 'string' ? item.artist : '' };
    }
  } catch { /* Storage may be unavailable in private browsing. */ }
  return null;
}

async function requestJSON(url, timeoutMs = 6500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, referrerPolicy: 'strict-origin-when-cross-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error('Metadata unavailable');
    return data;
  } finally { clearTimeout(timeout); }
}

export class RadioPlayer extends EventTarget {
  constructor(config) {
    super();
    this.config = config;
    this.player = null;
    this.shell = null;
    this.state = 'tuning';
    this.ready = false;
    this.error = '';
    this.tracks = [];
    this.index = 0;
    this.volume = clamp(Number(config.audio?.volume ?? 70), 0, 100);
    this.muted = false;
    this._time = 0;
    this._duration = 0;
    this._sampleAt = performance.now();
    this._rate = 1;
    this._pendingPlay = false;
    this._wantsPlay = false;
    this._awaitingPlayback = false;
    this._lastTrackId = '';
    this._lastPlaylistKey = '';
    this._failedIndices = new Set();
    this._blockedIds = new Set();
    this._failures = 0;
    this._metadata = new Map();
    this._metadataQueued = new Set();
    this._metadataQueue = [];
    this._metadataWorkers = 0;
    this._dataAPIInFlight = Boolean(config.YT_API_KEY);
    this._rescueShown = false;
    this._rescueVisible = false;
    this._rescueCompleted = false;
    this._disposed = false;
    this._ignoreSamplesUntil = 0;
  }

  init() {
    if (this._initialization) return this._initialization;
    this._initialization = this._initialize();
    return this._initialization;
  }

  async _initialize() {
    if (!/^https?:$/.test(location.protocol)) {
      this._fatal('Ouvre ce site en http(s), par exemple avec « npx serve . ». YouTube ne fonctionne pas depuis file:// (Referer requis, erreur 153).');
      return this;
    }
    if (!this.config.PLAYLIST_ID) {
      this._fatal('Renseigne CONFIG.PLAYLIST_ID dans src/main.js pour capter la station.');
      return this;
    }
    this.shell = document.getElementById('youtube-shell');
    if (!this.shell) {
      this._fatal('Le conteneur du lecteur YouTube est introuvable.');
      return this;
    }
    let target = document.getElementById('youtube-player');
    if (!target) {
      target = document.createElement('div');
      target.id = 'youtube-player';
      this.shell.append(target);
    }
    this.shell.setAttribute('aria-hidden', 'true');
    try {
      const YT = await loadIframeAPI();
      if (this._disposed) return this;
      this.player = new YT.Player(target, {
        width: 200,
        height: 200,
        playerVars: {
          listType: 'playlist', list: this.config.PLAYLIST_ID,
          autoplay: 0, controls: 0, disablekb: 1, playsinline: 1,
          rel: 0, iv_load_policy: 3, origin: location.origin,
        },
        events: {
          onReady: (event) => this._onReady(event),
          onStateChange: (event) => this._onStateChange(event.data),
          onError: (event) => this._onError(Number(event.data)),
          onAutoplayBlocked: () => this._showRescue(),
        },
      });
      this._readyTimeout = setTimeout(() => {
        if (!this.ready) this._fatal('Le lecteur YouTube est bloqué ou ne répond pas. Vérifie la connexion et ton bloqueur de contenu, puis recharge la page.');
      }, 18000);
    } catch (error) {
      this._fatal(error.message || 'Impossible de charger YouTube. Vérifie ta connexion et ton bloqueur de contenu.');
    }
    return this;
  }

  _onReady(event) {
    if (this._disposed) return;
    clearTimeout(this._readyTimeout);
    this.player = event.target;
    this.ready = true;
    this.state = 'ready';
    this.error = '';
    const iframe = this.player.getIframe();
    iframe.title = 'Lecteur audio YouTube — activation de la station';
    iframe.tabIndex = -1;
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
    this.player.cuePlaylist({ listType: 'playlist', list: this.config.PLAYLIST_ID, index: 0, startSeconds: 0 });
    this.player.setShuffle(false);
    this.player.setLoop(true);
    this.player.setVolume(this.volume);
    if (this.muted) this.player.mute();
    this._pollTimer = setInterval(() => this._poll(), 250);
    this._emit();
    if (this.config.YT_API_KEY) this._loadDataAPI();
    // An early click is remembered. If its activation has expired, the mini-TV
    // supplies a fresh native YouTube gesture rather than silently failing.
    if (this._pendingPlay) this.play();
  }

  _onStateChange(code) {
    if (this._disposed) return;
    this._sampleTiming();
    if (code === 1) {
      clearTimeout(this._autoplayTimer);
      this._awaitingPlayback = false;
      clearTimeout(this._skipTimer);
      this._pendingPlay = false;
      this._wantsPlay = true;
      this._failures = 0;
      this.error = '';
      this.state = 'playing';
      if (this._rescueShown) this._rescueCompleted = true;
      this._hideRescue();
    } else if (code === 2) {
      this.state = 'paused';
      // A refused play() may report PAUSED. Keep the 1.5 s activation guard
      // alive until PLAYING/BUFFERING, or an explicit call to our pause().
      if (!this._awaitingPlayback) this._wantsPlay = false;
      this._pendingPlay = false;
    } else if (code === 3) {
      this.state = 'buffering';
      clearTimeout(this._autoplayTimer);
      this._awaitingPlayback = false;
    } else if (code === 5) {
      this.state = 'ready';
      this.player.setShuffle(false);
      this.player.setLoop(true);
    } else if (code === 0) {
      // YouTube handles playlist advance/loop. Calling nextVideo here as well
      // would race its native advance and sometimes skip an extra track.
      this.state = this._wantsPlay ? 'buffering' : 'paused';
    } else if (code === -1 && this.state !== 'error') {
      this.state = this._wantsPlay ? 'buffering' : 'ready';
    }
    this._syncPlaylist();
    this._syncTrack();
    if (code === 1) {
      const track = this.tracks[this.index];
      this._failedIndices.delete(this.index);
      if (track?.blocked) {
        this._blockedIds.delete(track.id);
        track.blocked = false;
      }
    }
    this._sampleAt = performance.now();
    this._emit();
  }

  _poll() {
    if (!this.ready || this._disposed) return;
    this._syncPlaylist();
    this._syncTrack();
    this._sampleTiming();
    this._emit();
  }

  _syncPlaylist() {
    let ids;
    try { ids = this.player.getPlaylist(); } catch { return; }
    if (!Array.isArray(ids) || !ids.length) return;
    const key = ids.join('|');
    if (key === this._lastPlaylistKey) return;
    this._lastPlaylistKey = key;
    this.tracks = ids.map((id) => {
      const metadata = this._metadata.get(id) || cachedMetadata(id);
      if (metadata) this._metadata.set(id, metadata);
      return {
        id,
        title: metadata?.title || 'Tuning the frequency',
        artist: metadata?.artist || '',
        blocked: this._blockedIds.has(id),
      };
    });
    if (!this._dataAPIInFlight) this.tracks.forEach((track) => this._queueMetadata(track.id));
  }

  _syncTrack() {
    let index = this.index;
    let data = {};
    try {
      const candidate = this.player.getPlaylistIndex();
      if (Number.isInteger(candidate) && candidate >= 0) index = candidate;
      data = this.player.getVideoData?.() || {};
    } catch { /* The iframe may momentarily be between videos. */ }
    // The playlist index is authoritative; videoData can briefly contain the
    // previous video during a transition, so never apply it to a different ID.
    const id = this.tracks[index]?.id || data.video_id || '';
    const changed = this.index !== index || (id && id !== this._lastTrackId);
    this.index = index;
    if (changed) {
      this._lastTrackId = id;
      this._time = 0;
      this._duration = 0;
      this._sampleAt = performance.now();
      this._ignoreSamplesUntil = 0;
    }
    if (data.title && data.video_id && data.video_id === id) {
      this._storeMetadata(id, parseTitle(data.title), false);
    }
    if (changed) {
      this._sampleTiming();
      this.dispatchEvent(new CustomEvent('trackchange', { detail: this.snapshot() }));
    }
  }

  _sampleTiming() {
    if (!this.ready) return;
    const now = performance.now();
    try {
      const duration = Number(this.player.getDuration());
      if (Number.isFinite(duration) && duration > 0) this._duration = duration;
      if (now >= this._ignoreSamplesUntil) {
        const time = Number(this.player.getCurrentTime());
        if (Number.isFinite(time) && time >= 0) {
          this._time = time;
          this._sampleAt = now;
        }
      }
      this._rate = Number(this.player.getPlaybackRate?.()) || 1;
    } catch { /* Keep the last valid timing sample through iframe transitions. */ }
  }

  snapshot() {
    const elapsed = this.state === 'playing' ? (performance.now() - this._sampleAt) / 1000 * this._rate : 0;
    return {
      state: this.state,
      time: clamp(this._time + elapsed, 0, this._duration || Infinity),
      duration: this._duration,
      index: this.index,
      tracks: this.tracks,
      volume: this.volume,
      muted: this.muted,
      ready: this.ready,
      error: this.error,
      stationId: this._duration > 0 && this._duration < 30,
    };
  }

  toggle() {
    if (this.state === 'playing' || this._wantsPlay || this._pendingPlay) this.pause();
    else this.play();
  }

  play() {
    this._wantsPlay = true;
    if (!this.ready) {
      this._pendingPlay = true;
      if (this.state === 'error') this._notice(this.error, 'error');
      else this._emit();
      return;
    }
    // Do not place an await, fetch, timer or promise before this API call.
    this.player.playVideo();
    this._pendingPlay = false;
    this.error = '';
    if (this.state === 'error') this.state = 'ready';
    this._armAutoplayGuard();
    this._emit();
  }

  pause() {
    this._time = this.snapshot().time;
    this._sampleAt = performance.now();
    this._wantsPlay = false;
    this._pendingPlay = false;
    this._awaitingPlayback = false;
    clearTimeout(this._autoplayTimer);
    clearTimeout(this._skipTimer);
    if (this.ready) {
      this.player.pauseVideo();
      this.state = 'paused';
    }
    this._hideRescue();
    this._emit();
  }

  next() { this._navigate(1); }
  previous() { this._navigate(-1); }

  _navigate(direction) {
    if (!this.ready) return;
    clearTimeout(this._skipTimer);
    const target = this._availableIndex(direction);
    if (target === null) {
      this._fatal('Toutes les pistes de cette playlist sont indisponibles pour l’intégration YouTube. Essaie une autre playlist dans CONFIG.');
      return;
    }
    this._prepareNavigation();
    if (this.tracks.length && target !== (this.index + direction + this.tracks.length) % this.tracks.length) {
      this.player.playVideoAt(target);
    } else if (direction > 0) this.player.nextVideo();
    else this.player.previousVideo();
    this._armAutoplayGuard();
    this._emit();
  }

  select(index) {
    if (!this.ready || !Number.isInteger(index) || index < 0 || index >= this.tracks.length) return;
    clearTimeout(this._skipTimer);
    // An explicit selection may retry a previously unavailable video.
    this._blockedIds.delete(this.tracks[index].id);
    this._failedIndices.delete(index);
    this.tracks[index].blocked = false;
    this._prepareNavigation();
    this.player.playVideoAt(index);
    this._armAutoplayGuard();
    this._emit();
  }

  _prepareNavigation() {
    this._wantsPlay = true;
    this._pendingPlay = false;
    this.error = '';
    this.state = 'buffering';
    this._time = 0;
    this._duration = 0;
    this._sampleAt = performance.now();
  }

  _availableIndex(direction = 1) {
    if (!this.tracks.length) return this.index + direction;
    for (let step = 1; step <= this.tracks.length; step++) {
      const index = (this.index + direction * step + this.tracks.length) % this.tracks.length;
      if (!this.tracks[index].blocked) return index;
    }
    return null;
  }

  seek(seconds) {
    if (!this.ready || !Number.isFinite(seconds) || !this._duration) return;
    const target = clamp(seconds, 0, Math.max(0, this._duration - 0.05));
    this.player.seekTo(target, true);
    this._time = target;
    this._sampleAt = performance.now();
    this._ignoreSamplesUntil = this._sampleAt + 650;
    this._emit();
  }

  setVolume(volume) {
    if (!Number.isFinite(Number(volume))) return;
    this.volume = clamp(Number(volume), 0, 100);
    if (this.ready) this.player.setVolume(this.volume);
    if (this.muted && this.volume > 0) {
      this.muted = false;
      if (this.ready) this.player.unMute();
    }
    this._emit();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ready) {
      if (this.muted) this.player.mute();
      else this.player.unMute();
    }
    this._emit();
  }

  _armAutoplayGuard() {
    clearTimeout(this._autoplayTimer);
    this._awaitingPlayback = true;
    this._autoplayTimer = setTimeout(() => {
      this._awaitingPlayback = false;
      if (!this._wantsPlay) return;
      let nativeState;
      try { nativeState = this.player.getPlayerState(); } catch { nativeState = -1; }
      if (nativeState !== 1 && nativeState !== 3) this._showRescue();
    }, 1500);
  }

  _showRescue() {
    if (!this._wantsPlay || this._disposed || this._rescueCompleted || this._rescueVisible || this.state === 'error') return;
    clearTimeout(this._autoplayTimer);
    this._awaitingPlayback = false;
    this._rescueShown = true;
    this._rescueVisible = true;
    this.shell?.classList.add('needs-tap');
    this.shell?.setAttribute('aria-hidden', 'false');
    const iframe = this.player?.getIframe?.();
    if (iframe) iframe.tabIndex = 0;
    this._notice('Tape une fois sur le bouton de lecture de la mini-TV pour autoriser le son. Elle disparaîtra dès le démarrage.', 'info');
  }

  _hideRescue() {
    this._rescueVisible = false;
    this.shell?.classList.remove('needs-tap');
    this.shell?.setAttribute('aria-hidden', 'true');
    const iframe = this.player?.getIframe?.();
    if (iframe) iframe.tabIndex = -1;
  }

  _onError(code) {
    clearTimeout(this._autoplayTimer);
    this._awaitingPlayback = false;
    clearTimeout(this._skipTimer);
    if (code === 153) {
      this._fatal('YouTube 153 : sers le site en http(s) avec un Referer. Garde la politique « strict-origin-when-cross-origin » et autorise le Referer dans ton navigateur.');
      return;
    }
    if (!BLOCKED_ERRORS.has(code)) {
      this._fatal(`YouTube ne peut pas lire cette station (erreur ${code}). Vérifie ta connexion, puis recharge la page.`);
      return;
    }
    this._syncPlaylist();
    this._syncTrack();
    this._failures++;
    this._failedIndices.add(this.index);
    const track = this.tracks[this.index];
    if (track) {
      track.blocked = true;
      this._blockedIds.add(track.id);
    }
    const maxAttempts = this.tracks.length || 3;
    if (this._failures >= maxAttempts || (this.tracks.length && this.tracks.every((item) => item.blocked))) {
      this._fatal('Aucune piste accessible : YouTube refuse l’intégration de cette playlist. La recherche est arrêtée pour éviter une boucle.');
      return;
    }
    this.state = 'error';
    this.error = `Piste bloquée par YouTube (${code}). Passage à la suivante…`;
    this._notice(this.error, 'warning');
    this._emit();
    this._skipTimer = setTimeout(() => {
      if (this._wantsPlay) this._navigate(1);
      else this._cueNextAvailable();
    }, 1000);
  }

  _cueNextAvailable() {
    const index = this._availableIndex(1);
    if (index === null) {
      this._fatal('Aucune piste accessible : YouTube refuse l’intégration de cette playlist.');
      return;
    }
    // An unavailable initial thumbnail can emit onError before the first click.
    // Move the cue without turning a background recovery into unsolicited play.
    this.state = 'ready';
    this.error = '';
    this._time = this._duration = 0;
    this._sampleAt = performance.now();
    this.player.cuePlaylist({ listType: 'playlist', list: this.config.PLAYLIST_ID, index, startSeconds: 0 });
    this.player.setShuffle(false);
    this.player.setLoop(true);
    this._emit();
  }

  _fatal(message) {
    clearTimeout(this._autoplayTimer);
    clearTimeout(this._skipTimer);
    this._wantsPlay = false;
    this._pendingPlay = false;
    this._awaitingPlayback = false;
    this.state = 'error';
    this.error = message;
    this._hideRescue();
    this._notice(message, 'error');
    this._emit();
  }

  _queueMetadata(id) {
    if (!id || this._metadata.has(id) || this._metadataQueued.has(id)) return;
    this._metadataQueued.add(id);
    this._metadataQueue.push(id);
    this._drainMetadata();
  }

  _drainMetadata() {
    // A small pool avoids flooding YouTube with 35 requests on first load.
    while (!this._disposed && this._metadataWorkers < 3 && this._metadataQueue.length) {
      const id = this._metadataQueue.shift();
      this._metadataWorkers++;
      this._loadMetadata(id).finally(() => {
        this._metadataWorkers--;
        this._drainMetadata();
      });
    }
  }

  async _loadMetadata(id) {
    const videoURL = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    const urls = [
      `https://www.youtube.com/oembed?url=${encodeURIComponent(videoURL)}&format=json`,
      `https://noembed.com/embed?url=${encodeURIComponent(videoURL)}`,
    ];
    for (const url of urls) {
      if (this._disposed || this._metadata.has(id)) return;
      try {
        const data = await requestJSON(url);
        if (data.title) {
          this._storeMetadata(id, parseTitle(data.title));
          return;
        }
      } catch { /* CORS/network errors fall through to the next public provider. */ }
    }
    // getVideoData() remains the final source when this video starts playing.
  }

  async _loadDataAPI() {
    let nextPage = '';
    let pages = 0;
    try {
      do {
        const query = new URLSearchParams({
          part: 'snippet', playlistId: this.config.PLAYLIST_ID,
          maxResults: '50', key: this.config.YT_API_KEY,
        });
        if (nextPage) query.set('pageToken', nextPage);
        const data = await requestJSON(`https://www.googleapis.com/youtube/v3/playlistItems?${query}`);
        for (const item of data.items || []) {
          const snippet = item.snippet;
          const id = snippet?.resourceId?.videoId;
          if (id && snippet.title && !/^(?:Deleted|Private) video$/i.test(snippet.title)) {
            this._storeMetadata(id, parseTitle(snippet.title), false);
          }
        }
        this._emit();
        nextPage = data.nextPageToken || '';
      } while (nextPage && ++pages < 20 && !this._disposed);
    } catch {
      this._notice('La clé YouTube Data API ne répond pas : les titres sont récupérés via les métadonnées publiques.', 'info');
    } finally {
      this._dataAPIInFlight = false;
      this.tracks.forEach((track) => this._queueMetadata(track.id));
    }
  }

  _storeMetadata(id, metadata, emit = true) {
    if (this._disposed || !id || !metadata.title) return;
    const previous = this._metadata.get(id);
    if (previous?.title === metadata.title && previous?.artist === metadata.artist) return;
    this._metadata.set(id, metadata);
    try { localStorage.setItem(CACHE_PREFIX + id, JSON.stringify(metadata)); } catch { /* Cache is optional. */ }
    for (const track of this.tracks) {
      if (track.id === id) Object.assign(track, metadata);
    }
    if (emit) this._emit();
  }

  _notice(message, kind = 'info') {
    this.dispatchEvent(new CustomEvent('notice', { detail: { message, kind } }));
  }

  _emit() {
    if (!this._disposed) this.dispatchEvent(new CustomEvent('change', { detail: this.snapshot() }));
  }

  destroy() {
    this._disposed = true;
    clearInterval(this._pollTimer);
    clearTimeout(this._readyTimeout);
    clearTimeout(this._autoplayTimer);
    clearTimeout(this._skipTimer);
    this.player?.destroy?.();
  }
}
