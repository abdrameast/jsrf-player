/** Screen-space ink, paint and spectrum. All music inputs share AudioFeatures. */
const TAU = Math.PI * 2;
const clamp = (number, min = 0, max = 1) => Math.max(min, Math.min(max, number));
const follow = (current, target, dt, response = 12) => current + (target - current) * (1 - Math.exp(-dt * response));

export class RadioFX {
  constructor({ canvas, stage, config, reducedMotion = false }) {
    this.canvas = canvas;
    this.stage = stage;
    this.config = config;
    this.reducedMotion = Boolean(reducedMotion);
    this.ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    const palette = config.palette || {};
    this.ink = palette.ink || '#0E0E10';
    this.paper = palette.paper || '#F3F0E6';
    this.colors = [palette.acid || '#A6F000', palette.cyan || '#1AD1FF', palette.magenta || '#FF2D95', palette.yellow || '#FFE14A', palette.orange || '#FF6B1A', palette.violet || '#7A3CFF'];
    this.accents = [this.colors[0], this.colors[2], this.colors[1], ...this.colors.slice(3)];
    this.particles = [];
    this.marks = [];
    this.bars = new Float32Array(96);
    this.maxParticles = clamp(Number(config.fx?.particles ?? 600), 0, 600);
    this.low = false;
    this.elapsed = 0;
    this.lastBeat = -1;
    this.lastFlash = -1;
    this.lastKick = 0;
    this.lastBeatValue = 0;
    this.lastBoil = -1;
    this.energy = 0;
    this.bass = 0;
    this.kick = 0;
    this.flashAge = 10;
    this.burstAge = 10;
    this.wordIndex = 0;
    this.beatWord = document.getElementById('beat-word');
    this.boil = document.getElementById('boil');
    this.disposed = false;
    this.resize();
  }

  resize() {
    this.rect = this.stage.getBoundingClientRect();
    const width = Math.max(1, this.rect.width);
    const height = Math.max(1, this.rect.height);
    if (this.width && this.height) {
      const sx = width / this.width;
      const sy = height / this.height;
      for (const item of [...this.particles, ...this.marks]) {
        item.x *= sx;
        item.y *= sy;
        if ('ground' in item) item.ground *= sy;
      }
    }
    this.width = width;
    this.height = height;
    this.dpr = Math.min(window.devicePixelRatio || 1, this.low ? 1.5 : 2);
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.ctx?.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  update(dt, time, features, playback, discScreen) {
    if (!this.ctx || this.disposed) return;
    dt = clamp(Number(dt) || 0, 0, .06);
    this.elapsed += dt;
    this.rect = this.stage.getBoundingClientRect();
    const playing = playback?.state === 'playing';
    const level = clamp(Number(features?.level) || 0);
    const bass = clamp(Number(features?.bass) || 0);
    const kick = clamp(Number(features?.kick) || 0);
    const beat = clamp(Number(features?.beat) || 0);
    this.energy = follow(this.energy, playing ? level : 0, dt, playing ? 10 : 4);
    this.bass = follow(this.bass, playing ? bass : 0, dt, 11);
    this.kick = follow(this.kick, playing ? kick : 0, dt, 17);
    this.flashAge += dt;
    this.burstAge += dt;

    const disc = {
      x: Number.isFinite(discScreen?.x) ? discScreen.x - this.rect.left : this.width * .7,
      y: Number.isFinite(discScreen?.y) ? discScreen.y - this.rect.top : this.height * .5,
      radius: Math.max(24, Number(discScreen?.radius) || Math.min(this.width, this.height) * .29),
    };
    this.disc = disc;
    this.accent = this.accents[Math.max(0, Number(playback?.index) || 0) % this.accents.length];
    const rising = (kick > .55 && kick > this.lastKick + .15) || (beat > .6 && beat > this.lastBeatValue + .3);
    // AUTO freezes its features when paused. A level threshold alone would
    // continuously re-fire the same frozen kick, so require a new rising edge.
    if (playing && rising && this.elapsed - this.lastBeat >= .4 && !this.reducedMotion) {
      this.lastBeat = this.elapsed;
      this.burstAge = 0;
      this._emitPaint(disc, level, kick);
      this._popWord();
    }
    this.lastKick = kick;
    this.lastBeatValue = beat;
    this.stage.style.setProperty('--bass', this.bass.toFixed(3));
    this.stage.style.setProperty('--kick', (this.reducedMotion ? 0 : this.kick).toFixed(3));
    if (!this.reducedMotion && this.boil && this.elapsed - this.lastBoil >= .1) {
      this.lastBoil = this.elapsed;
      this.boil.setAttribute('seed', String(Math.floor(this.elapsed * 10) % 97));
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.low && discScreen?.reflection) this._drawReflection(discScreen.reflection, disc);
    this._updateMarks(dt);
    this._updateParticles(dt);
    this._drawRing(dt, features?.spectrum, disc, playing);
    if (!this.reducedMotion) this._drawBurst(disc);
    this._drawWaveform(features?.waveform, playing);
    if (this.beatWord && this.elapsed >= (this.wordUntil || Infinity)) this.beatWord.classList.remove('pop');
  }

  _drawRing(dt, spectrum, disc, playing) {
    const ctx = this.ctx;
    const radius = disc.radius + (this.width < 740 ? 16 : 22);
    const lineWidth = this.width < 740 ? 2 : 2.6;
    const scale = this.reducedMotion ? .4 : 1;
    // The ring lives outside the silhouette so the physical disc remains clear.
    ctx.lineCap = 'round';
    for (let i = 0; i < 96; i++) {
      const sample = spectrum?.length ? clamp(spectrum[Math.floor(i / 96 * spectrum.length)] || 0) : 0;
      const target = playing ? sample : sample * .035;
      this.bars[i] = follow(this.bars[i], target, dt, target > this.bars[i] ? 20 : 7);
      const angle = i / 96 * TAU - Math.PI / 2;
      const length = 2.5 + this.bars[i] * Math.min(30, disc.radius * .17) * scale;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const x = disc.x + cos * radius;
      const y = disc.y + sin * radius;
      const endX = disc.x + cos * (radius + length);
      const endY = disc.y + sin * (radius + length);
      const color = this.colors[Math.floor(i / 96 * this.colors.length)];
      ctx.globalAlpha = playing ? .45 + this.bars[i] * .45 : .32;
      ctx.strokeStyle = this.ink;
      ctx.lineWidth = lineWidth + 2.5;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(endX, endY); ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
      // Occasional peaks leave an ink-like hanging droplet at the marker tip.
      if (playing && this.bars[i] > .75 && i % 8 === 0) {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(endX, endY + 2, lineWidth, 0, TAU); ctx.fill();
      }
    }
    ctx.globalAlpha = .14;
    ctx.strokeStyle = this.paper;
    ctx.lineWidth = .6;
    ctx.setLineDash([1, 12]);
    ctx.beginPath(); ctx.arc(disc.x, disc.y, radius - 8, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    if (this.flashAge < .38 && !this.reducedMotion) {
      const progress = this.flashAge / .38;
      ctx.globalAlpha = (1 - progress) * .55;
      ctx.strokeStyle = this.accent || this.colors[0];
      ctx.lineWidth = 2.5 * (1 - progress) + .5;
      ctx.beginPath(); ctx.arc(disc.x, disc.y, radius + progress * 35, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  _drawReflection(reflection, disc) {
    if (!Number.isFinite(reflection.x) || !Number.isFinite(reflection.y)) return;
    const ctx = this.ctx;
    const x = reflection.x - this.rect.left;
    const y = reflection.y - this.rect.top;
    const intensity = clamp(Number(reflection.intensity) || 0);
    if (!intensity || x < -200 || x > this.width + 200 || y < -100 || y > this.height + 100) return;
    ctx.save();
    // The 3D module supplies the reflected-ray/backdrop intersection. Exclude
    // the disc itself; this is a projected streak on the surrounding scenery.
    ctx.beginPath(); ctx.rect(0, 0, this.width, this.height);
    ctx.moveTo(disc.x + disc.radius + 7, disc.y);
    ctx.arc(disc.x, disc.y, disc.radius + 7, 0, TAU);
    ctx.clip('evenodd');
    ctx.translate(x, y);
    ctx.rotate(Number(reflection.angle) || 0);
    ctx.globalCompositeOperation = 'screen';
    const width = Math.min(220, disc.radius * 1.1);
    const height = Math.max(8, disc.radius * .055);
    const gradient = ctx.createLinearGradient(-width, 0, width, 0);
    gradient.addColorStop(0, 'rgba(255,45,149,0)');
    gradient.addColorStop(.15, '#7A3CFF');
    gradient.addColorStop(.35, '#1AD1FF');
    gradient.addColorStop(.52, '#A6F000');
    gradient.addColorStop(.7, '#FFE14A');
    gradient.addColorStop(.86, '#FF6B1A');
    gradient.addColorStop(1, 'rgba(255,45,149,0)');
    ctx.fillStyle = gradient;
    for (let pass = 3; pass >= 1; pass--) {
      ctx.globalAlpha = intensity * (.035 + this.energy * .035) / pass;
      ctx.beginPath();
      ctx.ellipse(0, 0, width, height * pass, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  _emitPaint(disc, level, kick) {
    const cap = this.low ? Math.min(90, this.maxParticles) : this.maxParticles;
    const count = Math.min(cap - this.particles.length, this.low ? 4 : Math.floor(7 + level * 12));
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * TAU;
      const radius = disc.radius + 6;
      const speed = 45 + Math.random() * 85 + kick * 35;
      const x = disc.x + Math.cos(angle) * radius;
      const y = disc.y + Math.sin(angle) * radius;
      this.particles.push({
        x, y,
        vx: -Math.sin(angle) * speed + Math.cos(angle) * 18,
        vy: Math.cos(angle) * speed - 35,
        size: 1.2 + Math.random() * 2,
        color: this.colors[Math.floor(Math.random() * this.colors.length)],
        ground: Math.max(y + 30, this.height * (.73 + Math.random() * .17)),
        age: 0, life: 1.1 + Math.random() * .8,
      });
    }
  }

  _updateParticles(dt) {
    const ctx = this.ctx;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const drop = this.particles[i];
      drop.age += dt;
      drop.vy += 185 * dt;
      drop.x += drop.vx * dt;
      drop.y += drop.vy * dt;
      if (drop.y >= drop.ground || drop.age > drop.life) {
        if (drop.x > 0 && drop.x < this.width && drop.y < this.height) this._addMark(drop.x, drop.y, drop.size * 1.8, drop.color, false);
        this.particles.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = Math.min(1, (drop.life - drop.age) * 4) * .85;
      ctx.strokeStyle = this.ink;
      ctx.fillStyle = drop.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(drop.x, drop.y, drop.size, drop.size * 1.45, Math.atan2(drop.vy, drop.vx) - Math.PI / 2, 0, TAU);
      ctx.stroke(); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  _addMark(x, y, size, color, clicked = false) {
    const cap = this.low ? 35 : 90;
    if (this.marks.length >= cap) this.marks.shift();
    const flecks = [];
    if (clicked) {
      for (let i = 0; i < 9; i++) {
        const angle = Math.random() * TAU;
        const reach = size * (.9 + Math.random() * 1.6);
        flecks.push({ x: Math.cos(angle) * reach, y: Math.sin(angle) * reach, radius: 1 + Math.random() * size * .13 });
      }
    }
    this.marks.push({ x, y, size, color, clicked, flecks, age: 0, angle: Math.random() * TAU });
  }

  _updateMarks(dt) {
    const ctx = this.ctx;
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const mark = this.marks[i];
      mark.age += dt;
      if (mark.age >= 10) { this.marks.splice(i, 1); continue; }
      const drying = .7 - Math.min(mark.age / 3, 1) * .25;
      ctx.globalAlpha = drying * clamp((10 - mark.age) / 3);
      ctx.fillStyle = mark.color;
      ctx.strokeStyle = this.ink;
      ctx.lineWidth = mark.clicked ? 1.6 : .6;
      ctx.beginPath();
      // Irregular lobes are deterministic for the lifetime of each paint mark.
      for (let j = 0; j <= 20; j++) {
        const angle = j / 20 * TAU;
        const radius = mark.size * (1 + .16 * Math.sin(angle * 5 + mark.angle) + .1 * Math.cos(angle * 3));
        const x = mark.x + Math.cos(angle) * radius;
        const y = mark.y + Math.sin(angle) * radius * .7;
        if (!j) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath(); ctx.stroke(); ctx.fill();
      if (mark.clicked) {
        for (const fleck of mark.flecks) {
          ctx.beginPath(); ctx.arc(mark.x + fleck.x, mark.y + fleck.y, fleck.radius, 0, TAU); ctx.fill();
        }
        const drip = Math.min(24, mark.age * 8);
        ctx.strokeStyle = mark.color;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(mark.x + mark.size * .3, mark.y); ctx.lineTo(mark.x + mark.size * .3, mark.y + mark.size * .55 + drip); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  _drawBurst(disc) {
    if (this.burstAge > .3) return;
    const ctx = this.ctx;
    const fade = Math.pow(1 - this.burstAge / .3, 2);
    const inner = disc.radius + 57 + this.burstAge * 20;
    ctx.globalAlpha = fade * .35;
    ctx.lineCap = 'round';
    for (let i = 0; i < 9; i++) {
      const angle = i / 9 * TAU + .17;
      const length = 13 + (i % 3) * 9;
      ctx.strokeStyle = i % 3 ? this.paper : this.accent;
      ctx.lineWidth = i % 2 ? 1 : 2;
      ctx.beginPath();
      ctx.moveTo(disc.x + Math.cos(angle) * inner, disc.y + Math.sin(angle) * inner);
      ctx.lineTo(disc.x + Math.cos(angle) * (inner + length), disc.y + Math.sin(angle) * (inner + length));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  _drawWaveform(waveform, playing) {
    const ctx = this.ctx;
    const x = this.width * .08;
    const width = this.width * .87;
    const y = this.height - 50;
    const gain = (this.reducedMotion ? 3 : 8) * (playing ? .3 + this.energy : .05);
    const count = this.low ? 128 : 256;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const position = i / (count - 1);
      const value = waveform?.length ? clamp(Number(waveform[Math.floor(position * (waveform.length - 1))]) || 0, -1, 1) : 0;
      const envelope = Math.sin(position * Math.PI);
      const pointX = x + position * width;
      const pointY = y + value * gain * envelope;
      if (!i) ctx.moveTo(pointX, pointY); else ctx.lineTo(pointX, pointY);
    }
    ctx.globalAlpha = playing ? .28 + this.energy * .2 : .13;
    ctx.strokeStyle = this.ink; ctx.lineWidth = 3; ctx.stroke();
    ctx.strokeStyle = this.colors[0]; ctx.lineWidth = 1; ctx.stroke();
    ctx.globalAlpha = 1;
  }

  _popWord() {
    if (!this.beatWord) return;
    this.beatWord.textContent = ['ドン!', 'バン!', 'ズン!'][this.wordIndex++ % 3];
    this.beatWord.classList.remove('pop');
    // Restart the short sticker animation only on a new beat (at most 2.5 Hz).
    void this.beatWord.offsetWidth;
    this.beatWord.classList.add('pop');
    this.wordUntil = this.elapsed + .36;
  }

  splat(clientX, clientY) {
    if (this.disposed) return;
    const rect = this.stage.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > this.width || y > this.height) return;
    this._addMark(x, y, 11 + Math.random() * 12, this.accent || this.colors[0], true);
  }

  setQuality(low) {
    low = Boolean(low);
    if (this.low === low) return;
    this.low = low;
    if (low) {
      this.particles.splice(90);
      this.marks.splice(35);
    }
    this.resize();
  }

  flash() {
    // A track change is a local expanding spectrum ring, never a screen flash.
    if (this.reducedMotion || this.elapsed - this.lastFlash < .4) return;
    this.lastFlash = this.elapsed;
    this.flashAge = 0;
  }

  dispose() {
    this.disposed = true;
    this.particles.length = 0;
    this.marks.length = 0;
    this.beatWord?.classList.remove('pop');
    this.ctx?.clearRect(0, 0, this.width, this.height);
    this.stage.style.setProperty('--bass', '0');
    this.stage.style.setProperty('--kick', '0');
  }
}
