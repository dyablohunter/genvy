/**
 * Synthesized sci-fi UI sounds via WebAudio — zero asset files, instant load.
 * All sounds are short envelope-shaped oscillator/noise bursts.
 */
type SoundName =
  | 'hover'
  | 'click'
  | 'confirm'
  | 'error'
  | 'warn'
  | 'generate'
  | 'complete'
  | 'whoosh'
  | 'boot'
  | 'loot';

class UISoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private unlockAttached = false;
  enabled = true;

  /**
   * Browsers only allow creating/resuming audio inside a genuine user gesture.
   * These capture-phase listeners guarantee the context is unlocked by the
   * very next click or keypress, whatever state it got stuck in.
   */
  attachUnlock() {
    if (this.unlockAttached) return;
    this.unlockAttached = true;
    const unlock = () => {
      try {
        this.ensure();
        if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume();
      } catch {
        /* audio unavailable */
      }
    };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
  }

  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    try {
      if (!this.ctx || this.ctx.state === 'closed') {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.35;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    } catch (err) {
      console.warn('UISound: audio context unavailable', err);
      return null;
    }
  }

  private tone(
    freq: number,
    endFreq: number,
    duration: number,
    type: OscillatorType = 'sine',
    volume = 1,
    delay = 0,
  ) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), t0 + duration);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(volume, t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }

  private noise(duration: number, volume = 0.5, delay = 0, filterFrom = 4000, filterTo = 300) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + delay;
    const len = Math.ceil(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(filterFrom, t0);
    filter.frequency.exponentialRampToValueAtTime(filterTo, t0 + duration);
    filter.Q.value = 1.2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(volume, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t0);
  }

  play(name: SoundName) {
    try {
      this.playInternal(name);
    } catch (err) {
      console.warn('UISound: playback failed', err);
    }
  }

  private playInternal(name: SoundName) {
    switch (name) {
      case 'hover':
        this.tone(1400, 1800, 0.05, 'sine', 0.25);
        break;
      case 'click':
        // Holographic tap: fast energy chirp down + crystalline ping + air tick.
        this.tone(2400, 800, 0.055, 'sine', 0.22);
        this.tone(3200, 3200, 0.03, 'triangle', 0.12, 0.01);
        this.noise(0.035, 0.07, 0, 7000, 2500);
        break;
      case 'confirm':
        this.tone(660, 660, 0.08, 'triangle', 0.4);
        this.tone(990, 990, 0.1, 'triangle', 0.35, 0.07);
        break;
      case 'error':
        this.tone(220, 110, 0.22, 'sawtooth', 0.35);
        this.tone(160, 80, 0.25, 'square', 0.2, 0.04);
        break;
      case 'warn':
        // Two soft mid taps — "look at this", not "something broke": no
        // sawtooth growl, no downward slide, mid register instead of low.
        this.tone(520, 520, 0.09, 'triangle', 0.3);
        this.tone(440, 440, 0.12, 'triangle', 0.26, 0.1);
        break;
      case 'generate':
        this.tone(300, 1200, 0.5, 'sawtooth', 0.15);
        this.noise(0.5, 0.12, 0, 800, 3500);
        break;
      case 'complete':
        this.tone(523, 523, 0.09, 'triangle', 0.35);
        this.tone(659, 659, 0.09, 'triangle', 0.35, 0.09);
        this.tone(784, 784, 0.09, 'triangle', 0.35, 0.18);
        this.tone(1047, 1047, 0.25, 'triangle', 0.4, 0.27);
        break;
      case 'whoosh':
        this.noise(0.35, 0.3, 0, 3000, 200);
        break;
      case 'boot':
        this.tone(80, 440, 0.9, 'sawtooth', 0.12);
        this.tone(440, 880, 0.4, 'sine', 0.2, 0.7);
        this.tone(880, 1760, 0.3, 'sine', 0.15, 1.0);
        break;
      case 'loot':
        this.tone(880, 1760, 0.12, 'square', 0.2);
        this.tone(1320, 2640, 0.18, 'sine', 0.3, 0.08);
        this.noise(0.15, 0.08, 0.05, 5000, 8000);
        break;
    }
  }
}

export const UISound = new UISoundEngine();
