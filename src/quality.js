// A steady mobile budget avoids repeatedly enabling expensive effects as soon
// as the lighter renderer restores a good frame rate.
export class RenderBudget {
  constructor({ compact = false, coarsePointer = false, reducedMotion = false } = {}) {
    this.low = compact || coarsePointer || reducedMotion;
    this.fps = null;
    this.resetWindow();
  }

  resetWindow() {
    this.warmup = 1;
    this.elapsed = 0;
    this.frames = 0;
    this.slowWindows = 0;
  }

  useLowQuality() {
    if (this.low) return false;
    this.low = true;
    return true;
  }

  sample(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return false;
    // Ignore shader compilation / tab restoration before collecting a window.
    if (this.warmup > 0) { this.warmup -= dt; return false; }
    this.elapsed += dt;
    this.frames++;
    if (this.elapsed < 3) return false;
    this.fps = this.frames / this.elapsed;
    this.slowWindows = this.fps < 45 ? this.slowWindows + 1 : 0;
    this.elapsed = this.frames = 0;
    // Once reduced, keep the budget for this page session. A recovered frame
    // rate measures the reduced workload, not the capacity for heavier effects.
    return this.slowWindows >= 2 ? this.useLowQuality() : false;
  }
}
