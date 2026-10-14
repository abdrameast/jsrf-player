// All creative and playback settings live here. No bundler or build step.
export const CONFIG = {
  PLAYLIST_ID: 'PLE3VL-5NEtZjU9Ne8KSJbPgI9HfRcZRP0',
  STATION_NAME: 'GRIND//FM',
  YT_API_KEY: '', // Optional public, HTTP-referrer-restricted YouTube Data API key.
  palette: { ink: '#0E0E10', paper: '#F3F0E6', acid: '#A6F000', magenta: '#FF2D95', cyan: '#1AD1FF', yellow: '#FFE14A', orange: '#FF6B1A', violet: '#7A3CFF' },
  // Supplied PNG, calibrated on its transparent center hole; rotation in degrees.
  label: { offsetX: -0.00118, offsetY: 0.00305, scale: 1.03, rotation: 0, mode: 'white' },
  disc: { idleSpeed: 0.035, playSpeed: 2, precessionSpeed: 0.11, initialFace: 'label' },
  fx: { bloom: 0.32, diffraction: 1.3, sigma: 0.15, halation: 0.13, grain: 0.018, particles: 600 },
  lights: { key: 5, rim: 3 },
  rendering: { dpr: 2, toneMapping: 'Neutral' },
  audio: { volume: 70, bpm: 120, sfx: true },
  trackBpm: {}, // Optional: { YouTubeVideoId: 128 }. T records tempo for this session.
};

import { RadioPlayer } from './player.js';
import { AudioEngine } from './audio.js';
import { RadioFX } from './fx.js';
import { RadioUI } from './ui.js';
import { RenderBudget } from './quality.js';

const stage = document.querySelector('#stage');
const canvas = document.querySelector('#disc-canvas');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const compactViewport = matchMedia('(max-width: 740px)');
const renderBudget = new RenderBudget({ compact: compactViewport.matches,
  coarsePointer: matchMedia('(pointer: coarse)').matches, reducedMotion });
CONFIG.rendering.lowQuality = renderBudget.low;
document.documentElement.dataset.quality = renderBudget.low ? 'low' : 'high';
Object.entries(CONFIG.palette).forEach(([name, value]) => document.documentElement.style.setProperty(`--${name}`, value));
const player = new RadioPlayer(CONFIG);
const audio = new AudioEngine(CONFIG);
const fx = new RadioFX({ canvas: document.querySelector('#fx-canvas'), stage, config: CONFIG, reducedMotion });
let disc = null, gui = null, fallback = false;
function syncFallbackLabel() {
  const fallbackLabel = document.querySelector('#disc-fallback');
  fallbackLabel.dataset.labelMode = CONFIG.label.mode;
  fallbackLabel.style.setProperty('--label-scale', CONFIG.label.scale);
  fallbackLabel.style.setProperty('--label-x', `${-CONFIG.label.offsetX * 100}%`);
  fallbackLabel.style.setProperty('--label-y', `${CONFIG.label.offsetY * 100}%`);
  fallbackLabel.style.setProperty('--label-rotation', `${-CONFIG.label.rotation}deg`);
}
syncFallbackLabel();
const ui = new RadioUI({ config: CONFIG, player, audio,
  onLabelToggle: () => {
    CONFIG.label.mode = CONFIG.label.mode === 'silver' ? 'white' : 'silver';
    disc?.setLabelMode(CONFIG.label.mode);
    syncFallbackLabel();
    ui.toast(`Label ${CONFIG.label.mode === 'silver' ? 'argent' : 'papier'}.`);
  },
  onDebug: toggleDebug,
  onFullscreen: async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else ui.toast('Le plein écran n’est pas proposé par ce navigateur.');
    } catch { ui.toast('Le navigateur n’a pas autorisé le plein écran.', 'warning'); }
  },
  onSfxToggle: enabled => { CONFIG.audio.sfx = enabled; },
});

// Start the iframe immediately. The first gesture can be queued while it loads.
player.init();
const rendererReady = import('./disc.js').then(({ createDisc }) => createDisc({
  canvas, config: CONFIG, reducedMotion,
  onToggle: () => { player.toggle(); audio.sfx('scratch'); },
  onVolume: delta => { CONFIG.audio.volume = Math.min(100, Math.max(0, player.snapshot().volume + delta)); player.setVolume(CONFIG.audio.volume); },
  onSplat: (x, y) => { fx.splat(x, y); audio.sfx('spray'); },
  onNotice: message => ui.toast(typeof message === 'string' ? message : message.message, 'warning'),
})).then(result => {
  disc = result;
  disc.setQuality(renderBudget.low);
  if (disc.debug.lowQuality && renderBudget.useLowQuality()) applyQuality();
  renderBudget.resetWindow();
}).catch(error => {
  fallback = true;
  document.querySelector('#disc-fallback').hidden = false;
  ui.toast('WebGL indisponible : le disque 2D reste utilisable.', 'warning');
  // Keep the keyboard-focusable canvas as the hit target for the 2D fallback.
  canvas.addEventListener('click', () => player.toggle());
  canvas.addEventListener('wheel', event => {
    event.preventDefault(); player.setVolume(player.snapshot().volume - Math.sign(event.deltaY) * 5);
  }, { passive: false });
  console.info('GRIND FM: 2D fallback:', error.message);
});

let playlistInitialized = false;
player.addEventListener('trackchange', () => {
  // Initial playlist discovery is not a track transition: keep the supplied
  // artwork facing the listener at startup, then flip on actual track changes.
  if (playlistInitialized) { disc?.flip(); fx.flash(); }
  playlistInitialized = true;
});
stage.addEventListener('pointerdown', event => {
  if (event.target.closest('button,a,input,dialog') || event.target === canvas) return;
  fx.splat(event.clientX, event.clientY); audio.sfx('spray');
});
const planes = [...document.querySelectorAll('.parallax')];
let pointerX = 0, pointerY = 0, smoothX = 0, smoothY = 0;
stage.addEventListener('pointermove', event => {
  if (renderBudget.low) return;
  const r = stage.getBoundingClientRect();
  pointerX = (event.clientX - r.left) / r.width - 0.5;
  pointerY = (event.clientY - r.top) / r.height - 0.5;
  document.documentElement.style.setProperty('--pointer-x', `${50 + pointerX * 50}%`);
  document.documentElement.style.setProperty('--pointer-y', `${50 + pointerY * 50}%`);
});
stage.addEventListener('pointerleave', () => { pointerX = pointerY = 0; });
new ResizeObserver(() => { disc?.resize(); fx.resize(); }).observe(stage);

function applyQuality() {
  CONFIG.rendering.lowQuality = renderBudget.low;
  document.documentElement.dataset.quality = renderBudget.low ? 'low' : 'high';
  disc?.setQuality(renderBudget.low);
  fx.setQuality(renderBudget.low);
  planes.forEach(plane => { plane.style.transform = ''; });
}
compactViewport.addEventListener('change', event => {
  if (event.matches && renderBudget.useLowQuality()) applyQuality();
});

let previous = performance.now(), frameHandle;
function frame(now) {
  const wallDt = (now - previous) / 1000;
  const dt = Math.min(wallDt, 0.05); previous = now;
  const snapshot = player.snapshot();
  const features = audio.update(dt, snapshot);
  disc?.update(dt, now / 1000, features, snapshot);
  let screenDisc = disc?.getScreenDisc();
  if (!screenDisc) {
    const r = canvas.getBoundingClientRect();
    screenDisc = { x: r.left + r.width / 2, y: r.top + r.height / 2, radius: Math.min(r.width, r.height) * 0.34 };
  }
  fx.update(dt, now / 1000, features, snapshot, screenDisc);
  ui.update(snapshot, features);
  if (!reducedMotion && !renderBudget.low) {
    const smoothing = 1 - Math.exp(-dt * 4);
    smoothX += (pointerX - smoothX) * smoothing; smoothY += (pointerY - smoothY) * smoothing;
    planes.forEach(plane => { const depth = +plane.dataset.depth; plane.style.transform = `translate(${smoothX * depth}px,${smoothY * depth}px)`; });
  }
  if (disc && renderBudget.sample(wallDt)) applyQuality();
  frameHandle = requestAnimationFrame(frame);
}
frameHandle = requestAnimationFrame(frame);
document.addEventListener('visibilitychange', () => {
  cancelAnimationFrame(frameHandle);
  if (!document.hidden) { previous = performance.now(); renderBudget.resetWindow(); frameHandle = requestAnimationFrame(frame); }
});
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  cancelAnimationFrame(frameHandle); audio.destroy(); player.destroy(); disc?.dispose(); fx.dispose();
});

async function toggleDebug() {
  if (gui) { gui.show(gui._hidden); return; }
  await rendererReady;
  if (!disc?.debug) return ui.toast('Les réglages 3D demandent WebGL.');
  try {
    const { default: GUI } = await import('https://cdn.jsdelivr.net/npm/lil-gui@0.20.0/+esm');
    gui = new GUI({ title: 'GRIND // LAB', width: 280 });
    const apply = () => { disc.debug.applyConfig?.(); syncFallbackLabel(); };
    const label = gui.addFolder('Label — calibration');
    label.add(CONFIG.label, 'offsetX', -0.5, 0.5, 0.001).onChange(apply);
    label.add(CONFIG.label, 'offsetY', -0.5, 0.5, 0.001).onChange(apply);
    label.add(CONFIG.label, 'scale', 0.5, 2, 0.001).onChange(apply);
    label.add(CONFIG.label, 'rotation', -180, 180, 0.1).onChange(apply);
    label.add(CONFIG.label, 'mode', ['white', 'silver']).onChange(mode => { disc.setLabelMode(mode); syncFallbackLabel(); });
    const optics = gui.addFolder('Mirror / diffraction');
    optics.add(CONFIG.fx, 'sigma', 0.035, 0.4, 0.005).onChange(apply);
    optics.add(CONFIG.fx, 'diffraction', 0, 4, 0.05).onChange(apply);
    optics.add(CONFIG.fx, 'bloom', 0, 1.5, 0.01).onChange(apply);
    optics.add(CONFIG.fx, 'halation', 0, 0.5, 0.01).onChange(apply);
    optics.add(CONFIG.lights, 'key', 0, 12, 0.1).onChange(apply);
    optics.add(CONFIG.lights, 'rim', 0, 10, 0.1).onChange(apply);
    optics.add(CONFIG.rendering, 'toneMapping', ['Neutral', 'AgX']).onChange(apply);
    gui.add(CONFIG.disc, 'playSpeed', 0, 4, 0.05);
  } catch { ui.toast('Le panneau debug n’a pas pu charger depuis le CDN.', 'warning'); }
}

// Read-only inspection hook, useful for validating sources and the common feature bus.
window.GRIND = { config: CONFIG, player, audio, get disc() { return disc; }, get fallback() { return fallback; },
  get rendering() { return { quality: renderBudget.low ? 'low' : 'high', fps: renderBudget.fps }; } };
