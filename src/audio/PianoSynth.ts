/**
 * A small subtractive piano voice built on Web Audio.
 *
 * This is deliberately dependency-free so playback works offline and inside a
 * Capacitor shell with no sample download. It is a "get the vibe" instrument,
 * not a concert grand; the synth is behind the OutputSink interface so a real
 * sampled soundfont can replace it without touching the scheduler.
 */

export interface OutputSink {
  /** Schedule a note. `at` is in AudioContext time, regardless of sink. */
  noteOn(midi: number, at: number, duration: number, velocity: number): void;
  /** Silence everything currently sounding. */
  allOff(): void;
  dispose(): void;
}

const midiToFreq = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

export class PianoSynth implements OutputSink {
  private readonly master: GainNode;
  private readonly noise: AudioBuffer;
  private active: { stop: (at: number) => void }[] = [];

  constructor(private readonly ctx: AudioContext) {
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;

    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(compressor).connect(ctx.destination);

    // Short noise buffer reused for every hammer transient.
    this.noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.05), ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
  }

  setVolume(value: number): void {
    this.master.gain.setTargetAtTime(Math.max(0, Math.min(1, value)) * 0.5, this.ctx.currentTime, 0.02);
  }

  noteOn(midi: number, at: number, duration: number, velocity: number): void {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const peak = Math.max(0.02, Math.min(1, velocity)) * 0.32;

    const voice = ctx.createGain();
    voice.gain.value = 0;

    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(Math.min(12000, Math.max(900, freq * 8)), at);
    tone.frequency.setTargetAtTime(Math.min(6000, Math.max(500, freq * 3)), at, 0.35);
    tone.Q.value = 0.6;
    tone.connect(voice);
    voice.connect(this.master);

    // A few slightly stretched partials; real strings are mildly inharmonic.
    const partials: [number, number, OscillatorType][] = [
      [1, 1, 'triangle'],
      [2.001, 0.32, 'sine'],
      [3.004, 0.14, 'sine'],
      [4.01, 0.06, 'sine'],
    ];

    const oscillators: OscillatorNode[] = [];
    for (const [ratio, gainValue, type] of partials) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq * ratio;
      const partialGain = ctx.createGain();
      partialGain.gain.value = gainValue;
      osc.connect(partialGain).connect(tone);
      osc.start(at);
      oscillators.push(osc);
    }

    // Hammer transient.
    const hammer = ctx.createBufferSource();
    hammer.buffer = this.noise;
    const hammerFilter = ctx.createBiquadFilter();
    hammerFilter.type = 'bandpass';
    hammerFilter.frequency.value = Math.min(9000, freq * 4);
    hammerFilter.Q.value = 0.8;
    const hammerGain = ctx.createGain();
    hammerGain.gain.setValueAtTime(peak * 0.5, at);
    hammerGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    hammer.connect(hammerFilter).connect(hammerGain).connect(this.master);
    hammer.start(at);
    hammer.stop(at + 0.06);

    // Piano-like envelope: fast attack, continuous decay, short release at note end.
    // Bass strings ring noticeably longer than treble ones.
    const decayTau = 0.5 + Math.max(0, 96 - midi) * 0.035;
    const release = 0.12;
    const held = Math.max(0.05, duration);

    voice.gain.setValueAtTime(0, at);
    voice.gain.linearRampToValueAtTime(peak, at + 0.006);
    voice.gain.setTargetAtTime(0.0001, at + 0.006, decayTau);
    voice.gain.setTargetAtTime(0.0001, at + held, release);

    const stopAt = at + held + release * 6;
    for (const osc of oscillators) osc.stop(stopAt);

    const handle = {
      stop: (when: number) => {
        try {
          voice.gain.cancelScheduledValues(when);
          voice.gain.setTargetAtTime(0.0001, when, 0.015);
          for (const osc of oscillators) osc.stop(when + 0.1);
        } catch {
          // Already stopped.
        }
      },
    };
    this.active.push(handle);
    oscillators[0].onended = () => {
      this.active = this.active.filter((v) => v !== handle);
    };
  }

  allOff(): void {
    const now = this.ctx.currentTime;
    for (const voice of this.active) voice.stop(now);
    this.active = [];
  }

  dispose(): void {
    this.allOff();
    this.master.disconnect();
  }
}

/** Structural subset of Web MIDI's MIDIOutput, so we do not depend on its lib typings. */
export interface MidiOutputLike {
  id: string;
  name?: string | null;
  send(data: number[], timestamp?: number): void;
}

/** Sends to an external/OS MIDI device instead of synthesising in-page. */
export class MidiOutSink implements OutputSink {
  private sounding = new Set<number>();

  constructor(
    private readonly output: MidiOutputLike,
    private readonly ctx: AudioContext,
    private readonly channel = 0,
  ) {}

  /** Web MIDI schedules against performance.now(), not AudioContext time. */
  private toPerformanceTime(at: number): number {
    return performance.now() + (at - this.ctx.currentTime) * 1000;
  }

  noteOn(midi: number, at: number, duration: number, velocity: number): void {
    const value = Math.max(1, Math.min(127, Math.round(velocity * 127)));
    this.output.send([0x90 | this.channel, midi, value], this.toPerformanceTime(at));
    this.output.send([0x80 | this.channel, midi, 0], this.toPerformanceTime(at + duration));
    this.sounding.add(midi);
  }

  allOff(): void {
    for (const midi of this.sounding) this.output.send([0x80 | this.channel, midi, 0]);
    this.sounding.clear();
    // All Notes Off, in case a scheduled note-off is still pending.
    this.output.send([0xb0 | this.channel, 123, 0]);
  }

  dispose(): void {
    this.allOff();
  }
}
