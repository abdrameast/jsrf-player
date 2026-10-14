/** DOM radio controls. Metadata is always inserted as text, never HTML. */
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const two = (value) => String(value).padStart(2, '0');
const timecode = (seconds) => {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${two(Math.floor(value / 60))}:${two(value % 60)}`;
};
const TITLE_PENDING = 'Tuning the frequency';

export class RadioUI {
  constructor({ config, player, audio, onLabelToggle, onDebug, onFullscreen, onSfxToggle }) {
    this.config = config;
    this.player = player;
    this.audio = audio;
    this.callbacks = { onLabelToggle, onDebug, onFullscreen, onSfxToggle };
    this.nodes = {};
    for (const id of [
      'play', 'previous', 'next', 'mute', 'volume', 'volume-value', 'progress',
      'current-time', 'duration', 'track-title', 'track-artist', 'track-number',
      'play-state', 'air-label', 'audio-mode', 'mode-caption', 'sync', 'sync-dialog',
      'sync-live', 'sync-mic', 'sync-auto', 'help-dialog', 'help-button', 'fullscreen',
      'queue-toggle', 'queue-close', 'queue-backdrop', 'tracklist', 'track-rows',
      'queue-status', 'cut-count', 'sfx-toggle', 'toast', 'disc-canvas', 'track-slam',
      'interlude', 'intro',
    ]) this.nodes[id] = document.getElementById(id);
    this._listeners = [];
    this._timers = new Set();
    this._rows = new Map();
    this._rowSignature = '';
    this._lastSnapshot = player.snapshot();
    this._lastDomAt = -Infinity;
    this._lastTrackKey = '';
    this._lastAnimationAt = -Infinity;
    this._lastAnimatedTrack = '';
    this._hasEverPlayed = false;
    this._seeking = false;
    this._seekDirty = false;
    this._queueOpen = false;
    this._queueReturnFocus = null;
    this._dialogFocus = new Map();
    this._reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this._mobile = window.matchMedia('(max-width: 740px)');
    this._appShell = document.querySelector('.app-shell');
    this._airLed = document.querySelector('.air-led');
    this._trackBadge = document.querySelector('.explicit-badge');
    this._tickerLabel = document.querySelector('.deck-ticker > span:first-child');
    this._stationName = String(config.STATION_NAME || 'GRIND//FM');
    const palette = config.palette;
    this._accents = Array.isArray(palette) ? palette : ['acid', 'magenta', 'cyan', 'yellow', 'orange', 'violet'].map((key) => palette?.[key]).filter(Boolean);
    if (!this._accents.length) this._accents = ['#a6f000', '#ff2d95', '#1ad1ff', '#ffe14a', '#ff6b1a', '#7a3cff'];
    this._customizeStation();
    this._bindControls();
    this._bindDialogs();
    this._on(player, 'change', (event) => this.render(event.detail));
    this._on(player, 'trackchange', (event) => this._trackChanged(event.detail));
    this._on(player, 'notice', (event) => this.toast(event.detail.message, event.detail.kind));
    this._on(audio, 'notice', (event) => this.toast(event.detail.message, event.detail.kind));
    this._on(audio, 'modechange', () => this._renderAudioMode());
    this._on(document, 'keydown', (event) => this._keyboard(event));
    this._on(document, 'fullscreenchange', () => {
      const active = Boolean(document.fullscreenElement);
      this.nodes.fullscreen.setAttribute('aria-label', active ? 'Quitter le plein écran' : 'Plein écran');
      this.nodes.fullscreen.setAttribute('aria-pressed', String(active));
    });
    this.nodes.tracklist.setAttribute('aria-hidden', 'true');
    this.nodes.tracklist.setAttribute('role', 'dialog');
    this._renderAudioMode();
    this._renderSfx();
    this.render(this._lastSnapshot);
    this._later(() => this.nodes.intro?.remove(), this._reducedMotion.matches ? 100 : 1600);
  }

  _on(target, event, callback, options) {
    if (!target) return;
    target.addEventListener(event, callback, options);
    this._listeners.push(() => target.removeEventListener(event, callback, options));
  }

  _later(callback, delay) {
    const timer = setTimeout(() => { this._timers.delete(timer); callback(); }, delay);
    this._timers.add(timer);
    return timer;
  }

  _clearTimer(timer) {
    clearTimeout(timer);
    this._timers.delete(timer);
  }

  _text(node, value) {
    const text = String(value);
    if (node && node.textContent !== text) node.textContent = text;
  }

  _customizeStation() {
    const logo = document.querySelector('.station-logo');
    logo?.setAttribute('aria-label', `${this._stationName}, accueil`);
    if (logo && this._stationName !== 'GRIND//FM') {
      const name = logo.children[1];
      const small = document.createElement('small');
      small.textContent = 'UNLICENSED. UNFILTERED.';
      const parts = this._stationName.split('//');
      if (parts.length === 2) {
        const slash = document.createElement('span');
        slash.className = 'logo-slash';
        slash.textContent = '//';
        name.replaceChildren(document.createTextNode(parts[0]), slash, document.createTextNode(parts[1]), small);
      } else name.replaceChildren(document.createTextNode(this._stationName), small);
    }
    this._text(this.nodes.intro?.querySelector('span'), this._stationName);
    this._text(this.nodes.interlude?.querySelector('b'), this._stationName);
    this._on(logo, 'click', (event) => {
      event.preventDefault();
      this.closeQueue();
      this.nodes['disc-canvas'].focus({ preventScroll: true });
    });
  }

  _manualPlay() {
    // Keep the API call in the original click/key handler for mobile autoplay.
    this.player.toggle();
    document.body.classList.add('has-started');
    this.audio.sfx('scratch');
  }

  _navigate(direction) {
    if (direction < 0) this.player.previous();
    else this.player.next();
    document.body.classList.add('has-started');
    this.audio.sfx('scratch');
  }

  _bindControls() {
    const n = this.nodes;
    this._on(n.play, 'click', () => this._manualPlay());
    this._on(n.previous, 'click', () => this._navigate(-1));
    this._on(n.next, 'click', () => this._navigate(1));
    this._on(n.mute, 'click', () => { this.player.toggleMute(); this.audio.sfx('spray'); });
    this._on(n.volume, 'input', () => this._setVolume(n.volume.value));
    this._on(n['disc-canvas'], 'keydown', (event) => {
      if (event.code !== 'Space' && event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) this._manualPlay();
    });
    this._on(n.progress, 'pointerdown', () => { this._seeking = true; });
    this._on(n.progress, 'input', () => {
      this._seekDirty = true;
      this._previewSeek();
    });
    this._on(n.progress, 'change', () => this._commitSeek());
    this._on(window, 'pointerup', () => { if (this._seeking) this._commitSeek(); });
    this._on(window, 'pointercancel', () => {
      this._seeking = this._seekDirty = false;
      this.render(this.player.snapshot());
    });
    this._on(n['queue-toggle'], 'click', () => this._queueOpen ? this.closeQueue() : this.openQueue());
    this._on(n['queue-close'], 'click', () => this.closeQueue());
    this._on(n['queue-backdrop'], 'click', () => this.closeQueue());
    this._on(n['track-rows'], 'click', (event) => {
      const button = event.target.closest('button[data-index]');
      if (!button || button.disabled) return;
      this.player.select(Number(button.dataset.index));
      document.body.classList.add('has-started');
      this.audio.sfx('scratch');
      if (this._mobile.matches) this.closeQueue();
    });
    this._on(n.sync, 'click', () => this.openSync());
    this._on(n['help-button'], 'click', () => this._openDialog(n['help-dialog']));
    this._on(n.fullscreen, 'click', () => this._fullscreen());
    this._on(n['sfx-toggle'], 'click', () => {
      this.config.audio ||= {};
      const enabled = this.config.audio.sfx === false;
      this.config.audio.sfx = enabled;
      this.callbacks.onSfxToggle?.(enabled);
      this._renderSfx();
      if (enabled) this.audio.sfx('spray');
    });
  }

  _setVolume(value) {
    const volume = clamp(Number(value) || 0, 0, 100);
    this.config.audio ||= {};
    this.config.audio.volume = volume;
    this.player.setVolume(volume);
    this.render(this.player.snapshot());
  }

  _previewSeek() {
    const duration = this._lastSnapshot.duration || 0;
    const ratio = Number(this.nodes.progress.value) / 1000;
    const time = ratio * duration;
    this._text(this.nodes['current-time'], timecode(time));
    this.nodes.progress.style.setProperty('--progress', `${ratio * 100}%`);
    this.nodes.progress.setAttribute('aria-valuetext', `${timecode(time)} sur ${timecode(duration)}`);
  }

  _commitSeek() {
    if (this._seekDirty && this._lastSnapshot.duration > 0) {
      this.player.seek(Number(this.nodes.progress.value) / 1000 * this._lastSnapshot.duration);
    }
    this._seeking = this._seekDirty = false;
    this.render(this.player.snapshot());
  }

  _bindDialogs() {
    for (const dialog of [this.nodes['sync-dialog'], this.nodes['help-dialog']]) {
      this._on(dialog.querySelector('.dialog-close'), 'click', () => dialog.close());
      this._on(dialog, 'click', (event) => {
        if (event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
      });
      this._on(dialog, 'close', () => {
        const previous = this._dialogFocus.get(dialog);
        if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
        this._dialogFocus.delete(dialog);
      });
    }
    this._on(this.nodes['sync-live'], 'click', () => {
      // No await before these calls: capture must retain transient activation.
      const capture = this.audio.startLive();
      this.nodes['sync-dialog'].close();
      Promise.resolve(capture).catch(() => this.toast('La capture audio n’a pas pu démarrer.', 'error'));
    });
    this._on(this.nodes['sync-mic'], 'click', () => {
      const capture = this.audio.startMic();
      this.nodes['sync-dialog'].close();
      Promise.resolve(capture).catch(() => this.toast('Le microphone n’a pas pu démarrer.', 'error'));
    });
    this._on(this.nodes['sync-auto'], 'click', () => {
      this.audio.stopCapture();
      this.nodes['sync-dialog'].close();
      this.toast('AUTO — animation simulée, calée sur le temps de lecture. T permet de régler le tempo.');
    });
  }

  _openDialog(dialog) {
    if (dialog.open) return;
    if (this._queueOpen) this.closeQueue();
    this._dialogFocus.set(dialog, document.activeElement);
    dialog.showModal();
  }

  openSync() { this._openDialog(this.nodes['sync-dialog']); }

  openQueue() {
    if (this._queueOpen) return;
    this._queueOpen = true;
    this._queueReturnFocus = document.activeElement;
    this._previousOverflow = document.body.style.overflow;
    this._previousInert = Boolean(this._appShell?.inert);
    this.nodes.tracklist.inert = false;
    this.nodes.tracklist.classList.add('open');
    this.nodes.tracklist.setAttribute('aria-hidden', 'false');
    this.nodes.tracklist.setAttribute('aria-modal', 'true');
    this.nodes['queue-toggle'].setAttribute('aria-expanded', 'true');
    this.nodes['queue-backdrop'].hidden = false;
    if (this._appShell) this._appShell.inert = true;
    document.body.style.overflow = 'hidden';
    this.nodes['queue-close'].focus({ preventScroll: true });
    this._scrollToCurrent();
    this.audio.sfx('spray');
  }

  closeQueue() {
    if (!this._queueOpen) return;
    this._queueOpen = false;
    if (this._appShell) this._appShell.inert = this._previousInert;
    document.body.style.overflow = this._previousOverflow || '';
    this.nodes.tracklist.classList.remove('open');
    this.nodes.tracklist.inert = true;
    this.nodes.tracklist.setAttribute('aria-hidden', 'true');
    this.nodes.tracklist.removeAttribute('aria-modal');
    this.nodes['queue-toggle'].setAttribute('aria-expanded', 'false');
    this.nodes['queue-backdrop'].hidden = true;
    const target = this._queueReturnFocus?.isConnected ? this._queueReturnFocus : this.nodes['queue-toggle'];
    target.focus({ preventScroll: true });
    this._queueReturnFocus = null;
  }

  _scrollToCurrent() {
    const current = this.nodes['track-rows'].querySelector('button.current');
    if (!current) return;
    // Scroll only the list, never the whole page behind the drawer.
    const list = this.nodes['track-rows'];
    const top = current.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top + current.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = Math.max(0, top - list.clientHeight / 3);
  }

  _keyboard(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (this._queueOpen) {
      if (event.key === 'Escape') { event.preventDefault(); this.closeQueue(); }
      if (event.key === 'Tab') {
        const focusable = [...this.nodes.tracklist.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]')];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && (document.activeElement === first || !this.nodes.tracklist.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !this.nodes.tracklist.contains(document.activeElement))) {
          event.preventDefault(); first?.focus();
        }
      }
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest('input,textarea,select,[contenteditable="true"],.lil-gui')) return;
    const key = event.key.toLowerCase();
    if (event.code === 'Space') {
      // A focused button keeps its own native Space activation.
      if (target instanceof Element && target.closest('button,a')) return;
      event.preventDefault();
      if (!event.repeat) this._manualPlay();
      return;
    }
    if (event.repeat && !['arrowup', 'arrowdown'].includes(key)) return;
    const actions = {
      arrowleft: () => this._navigate(-1),
      arrowright: () => this._navigate(1),
      arrowup: () => this._setVolume(this.player.snapshot().volume + 5),
      arrowdown: () => this._setVolume(this.player.snapshot().volume - 5),
      m: () => this.player.toggleMute(),
      l: () => this.callbacks.onLabelToggle?.(),
      t: () => this.audio.tapTempo(),
      s: () => this.openSync(),
      f: () => this._fullscreen(),
      d: () => this.callbacks.onDebug?.(),
    };
    if (actions[key]) { event.preventDefault(); actions[key](); }
  }

  _fullscreen() {
    try {
      const result = this.callbacks.onFullscreen
        ? this.callbacks.onFullscreen()
        : document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
      if (!this.callbacks.onFullscreen && !document.documentElement.requestFullscreen) {
        this.toast('Le plein écran n’est pas disponible dans ce navigateur.');
      }
      Promise.resolve(result).catch(() => this.toast('Le navigateur n’a pas autorisé le plein écran.'));
    } catch { this.toast('Le plein écran n’est pas disponible dans ce navigateur.'); }
  }

  _renderAudioMode() {
    const mode = this.audio.mode || 'AUTO';
    this._text(this.nodes['audio-mode'], mode);
    this.nodes.sync.classList.toggle('active', mode !== 'AUTO');
    this.nodes.sync.setAttribute('aria-label', `Synchronisation audio : ${mode}. Choisir la source.`);
    const captions = {
      AUTO: 'AUTO VISUALS · TAP [T] TO SET THE TEMPO',
      LIVE: 'LIVE AUDIO · FOLLOWING YOUR SHARED SOUND',
      MIC: 'MIC INPUT · LISTENING TO YOUR SPEAKERS',
    };
    this._text(this.nodes['mode-caption'], captions[mode] || captions.AUTO);
    this.nodes['mode-caption'].title = mode === 'AUTO'
      ? 'Animation simulée à partir du temps de lecture. SYNC permet une vraie analyse audio.'
      : mode === 'LIVE' ? 'Analyse locale du son partagé. Rien n’est enregistré ni envoyé.'
        : 'Analyse locale du microphone. Rien n’est enregistré ni envoyé.';
  }

  _renderSfx() {
    const enabled = this.config.audio?.sfx !== false;
    this._text(this.nodes['sfx-toggle'], enabled ? 'SFX ON' : 'SFX OFF');
    this.nodes['sfx-toggle'].setAttribute('aria-pressed', String(enabled));
    this.nodes['sfx-toggle'].setAttribute('aria-label', enabled ? 'Désactiver les sons d’interface' : 'Activer les sons d’interface');
  }

  _trackChanged(snapshot) {
    this.render(snapshot);
    if (this._hasEverPlayed || ['playing', 'buffering'].includes(snapshot.state)) this._animateTrack(snapshot, this._hasEverPlayed);
  }

  _animateTrack(snapshot, interlude) {
    if (this._reducedMotion.matches) return;
    const track = snapshot.tracks?.[snapshot.index];
    if (!track) return;
    const key = `${snapshot.index}:${track.id}`;
    const now = performance.now();
    if (key === this._lastAnimatedTrack && now - this._lastAnimationAt < 1200) return;
    if (now - this._lastAnimationAt < 400) return;
    this._lastAnimatedTrack = key;
    this._lastAnimationAt = now;
    const slam = this.nodes['track-slam'];
    this._text(slam.querySelector('small'), snapshot.stationId ? 'PIRATE TRANSMISSION' : 'NEW FREQUENCY');
    this._text(slam.querySelector('strong'), snapshot.stationId ? 'STATION ID' : `TRACK ${two(snapshot.index + 1)}`);
    this._text(slam.querySelector('span'), track.title && track.title !== TITLE_PENDING ? track.title : 'JET SET RADIO FUTURE');
    this._clearTimer(this._slamTimer);
    slam.classList.remove('active');
    void slam.offsetWidth;
    slam.classList.add('active');
    this._slamTimer = this._later(() => slam.classList.remove('active'), 1800);
    if (interlude) {
      this._clearTimer(this._interludeTimer);
      this.nodes.interlude.classList.remove('active');
      void this.nodes.interlude.offsetWidth;
      this.nodes.interlude.classList.add('active');
      this._interludeTimer = this._later(() => this.nodes.interlude.classList.remove('active'), 600);
    }
  }

  /** Main can call update every frame. Text/queue mutations are throttled. */
  update(snapshot = this.player.snapshot(), features = this.audio.features, force = false) {
    this._lastSnapshot = snapshot;
    if (this._airLed) this._airLed.style.opacity = snapshot.state === 'playing' ? String(0.6 + clamp(features?.beat || 0) * 0.4) : '1';
    const now = performance.now();
    if (!force && now - this._lastDomAt < 80) return;
    this._lastDomAt = now;
    const n = this.nodes;
    const tracks = snapshot.tracks || [];
    const index = Math.max(0, Number(snapshot.index) || 0);
    const track = tracks[index];
    const playing = snapshot.state === 'playing';
    const title = track?.title && track.title !== TITLE_PENDING ? track.title : 'JET SET RADIO FUTURE';
    const artist = track?.artist || (title === 'JET SET RADIO FUTURE' ? 'THE COMPLETE SOUNDTRACK' : 'JET SET RADIO FUTURE');
    document.body.classList.toggle('is-playing', playing);
    document.body.classList.toggle('is-buffering', snapshot.state === 'buffering');
    if (playing || snapshot.time > 0) document.body.classList.add('has-started');
    if (playing && !this._hasEverPlayed) {
      this._hasEverPlayed = true;
      this._animateTrack(snapshot, false);
    }
    const playLabel = playing || snapshot.state === 'buffering' ? 'Pause' : 'Lire';
    n.play.setAttribute('aria-label', playLabel);
    n.play.setAttribute('aria-pressed', String(playing));
    n['disc-canvas'].setAttribute('aria-label', `${playLabel} la playlist — glissez pour faire tourner le disque`);
    this._text(n['track-title'], title);
    n['track-title'].title = title;
    this._text(n['track-artist'], artist);
    if (n['track-slam'].classList.contains('active')) {
      this._text(n['track-slam'].querySelector('span'), title);
      if (snapshot.stationId) {
        this._text(n['track-slam'].querySelector('small'), 'PIRATE TRANSMISSION');
        this._text(n['track-slam'].querySelector('strong'), 'STATION ID');
      }
    }
    this._text(n['track-number'], `TR ${two(index + 1)} / ${two(tracks.length || 35)}`);
    this._text(n['cut-count'], tracks.length || 35);
    this._text(this._trackBadge, snapshot.stationId ? 'STATION ID' : 'STEREO');
    this._text(this._tickerLabel, snapshot.stationId ? 'STATION ID' : 'NOW ON AIR');
    this._text(n['air-label'], playing ? 'ON AIR' : snapshot.state === 'buffering' ? 'TUNING' : 'STAND BY');
    const states = { tuning: 'TUNING…', ready: 'READY TO ROLL', playing: 'PLAYING', paused: 'PAUSED', buffering: 'BUFFERING…', error: 'SIGNAL LOST' };
    this._text(n['play-state'], states[snapshot.state] || 'TUNING…');
    const volume = Math.round(clamp(Number(snapshot.volume) || 0, 0, 100));
    if (document.activeElement !== n.volume) n.volume.value = String(volume);
    this._text(n['volume-value'], snapshot.muted ? '00' : two(volume));
    n.mute.setAttribute('aria-pressed', String(Boolean(snapshot.muted)));
    n.mute.setAttribute('aria-label', snapshot.muted ? 'Rétablir le son (M)' : 'Couper le son (M)');
    n.mute.style.opacity = snapshot.muted ? '0.45' : '1';
    n.previous.disabled = n.next.disabled = !snapshot.ready || tracks.length < 2;
    const duration = Number(snapshot.duration) || 0;
    this._text(n.duration, timecode(duration));
    n.progress.disabled = duration <= 0;
    if (!this._seeking && !this._seekDirty) {
      const time = Math.max(0, Number(snapshot.time) || 0);
      const progress = duration ? clamp(time / duration) : 0;
      n.progress.value = String(Math.round(progress * 1000));
      n.progress.style.setProperty('--progress', `${(progress * 100).toFixed(3)}%`);
      this._text(n['current-time'], timecode(time));
      n.progress.setAttribute('aria-valuetext', `${timecode(time)} sur ${timecode(duration)}`);
    }
    const trackKey = `${index}:${track?.id || ''}`;
    if (trackKey !== this._lastTrackKey) {
      this._lastTrackKey = trackKey;
      const accent = this._accents[index % this._accents.length];
      document.documentElement.style.setProperty('--accent', accent);
      if (this._queueOpen) this._later(() => this._scrollToCurrent(), 0);
    }
    const pageTitle = playing ? `${title} — ${this._stationName}` : `${this._stationName} — All city. All sound.`;
    if (document.title !== pageTitle) document.title = pageTitle;
    this._renderQueue(snapshot);
  }

  render(snapshot = this.player.snapshot(), features = this.audio.features) { this.update(snapshot, features, true); }

  _renderQueue(snapshot) {
    const tracks = snapshot.tracks || [];
    const signature = `${snapshot.index}|${snapshot.state}|${tracks.map((track) => `${track.id}:${track.title}:${track.artist}:${Boolean(track.blocked)}`).join('|')}`;
    const status = snapshot.error || (!tracks.length ? 'Connexion à la fréquence YouTube…' : tracks.every((track) => track.blocked) ? 'Toutes les pistes sont indisponibles dans ce lecteur.' : '');
    this._text(this.nodes['queue-status'], status);
    this.nodes['queue-status'].hidden = !status;
    if (signature === this._rowSignature) return;
    this._rowSignature = signature;
    const valid = new Set();
    tracks.forEach((track, index) => {
      // The playlist index is part of the key because playlists may repeat IDs.
      const key = `${index}:${track.id}`;
      valid.add(key);
      let row = this._rows.get(key);
      if (!row) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.index = String(index);
        const number = document.createElement('span'); number.className = 'track-row-number';
        const info = document.createElement('span');
        const title = document.createElement('span'); title.className = 'track-row-title';
        const artist = document.createElement('span'); artist.className = 'track-row-artist';
        const state = document.createElement('span'); state.className = 'track-row-status'; state.setAttribute('aria-hidden', 'true');
        info.append(title, artist); button.append(number, info, state); li.append(button);
        row = { li, button, number, title, artist, state };
        this._rows.set(key, row);
      }
      const current = index === snapshot.index;
      const title = track.title && track.title !== TITLE_PENDING ? track.title : `TRACK ${two(index + 1)}`;
      this._text(row.number, two(index + 1));
      this._text(row.title, title);
      this._text(row.artist, track.artist || (track.title === TITLE_PENDING ? 'Titre en cours de chargement…' : 'JET SET RADIO FUTURE'));
      this._text(row.state, track.blocked ? 'BLOCKED' : current ? snapshot.state === 'playing' ? '▶' : '●' : '↗');
      row.button.classList.toggle('current', current);
      row.button.classList.toggle('blocked', Boolean(track.blocked));
      row.button.disabled = Boolean(track.blocked);
      row.button.setAttribute('aria-label', `Piste ${index + 1}, ${title}${track.artist ? `, ${track.artist}` : ''}${track.blocked ? ', indisponible' : ''}`);
      if (current) row.button.setAttribute('aria-current', 'true');
      else row.button.removeAttribute('aria-current');
      // Append moves existing nodes without destroying their focus or listeners.
      const expected = this.nodes['track-rows'].children[index];
      if (expected !== row.li) this.nodes['track-rows'].insertBefore(row.li, expected || null);
    });
    for (const [key, row] of this._rows) {
      if (!valid.has(key)) { row.li.remove(); this._rows.delete(key); }
    }
    const heading = this.nodes.tracklist.querySelector('.queue-header h2');
    if (tracks.length && heading) {
      const label = `${tracks.length} CUTS.`;
      if (heading.firstChild?.nodeType === Node.TEXT_NODE) heading.firstChild.textContent = label;
    }
  }

  toast(message, kind = 'info') {
    if (!message) return;
    this._clearTimer(this._toastTimer);
    this.nodes.toast.dataset.kind = kind;
    this._text(this.nodes.toast, message);
    this.nodes.toast.classList.add('visible');
    this._toastTimer = this._later(() => this.nodes.toast.classList.remove('visible'), kind === 'error' ? 9000 : 6500);
  }

  destroy() {
    this.closeQueue();
    for (const remove of this._listeners) remove();
    for (const timer of this._timers) clearTimeout(timer);
    this._timers.clear();
    this._listeners.length = 0;
  }
}
