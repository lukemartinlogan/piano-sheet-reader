import type { PlayNote } from '../score/types';
import { MidiOutSink, PianoSynth, type MidiOutputLike, type OutputSink } from './PianoSynth';

const LOOKAHEAD_SECONDS = 0.25;
const TICK_MS = 25;

export interface PlayerState {
  playing: boolean;
  position: number;
  duration: number;
}

/**
 * Transport for a parsed score.
 *
 * Notes are pre-sorted by start time and released to the sink on a rolling
 * lookahead window, so a 129-measure score does not allocate thousands of
 * oscillators up front while still keeping sample-accurate timing.
 */
export class Player {
  private ctx: AudioContext | null = null;
  private synth: PianoSynth | null = null;
  private midiSink: MidiOutSink | null = null;

  private notes: PlayNote[] = [];
  private cursor = 0;
  private timer: number | null = null;

  /** AudioContext time at which the current playback run started. */
  private anchorCtxTime = 0;
  /** Score position, in seconds, corresponding to `anchorCtxTime`. */
  private anchorPosition = 0;
  private playing = false;

  private rate = 1;
  private volume = 0.8;
  private duration = 0;

  mutedStaves = new Set<number>();
  onUpdate: ((state: PlayerState) => void) | null = null;

  /** Created lazily: browsers require a user gesture before an AudioContext starts. */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        (window as any).AudioContext ?? (window as any).webkitAudioContext;
      this.ctx = new Ctor();
      this.synth = new PianoSynth(this.ctx);
      this.synth.setVolume(this.volume);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  load(notes: PlayNote[], duration: number): void {
    this.stop();
    this.notes = [...notes].sort((a, b) => a.start - b.start);
    this.duration = duration;
    this.anchorPosition = 0;
    this.cursor = 0;
    this.emit();
  }

  get state(): PlayerState {
    return { playing: this.playing, position: this.position, duration: this.duration };
  }

  get position(): number {
    if (!this.playing || !this.ctx) return this.anchorPosition;
    return this.anchorPosition + (this.ctx.currentTime - this.anchorCtxTime) * this.rate;
  }

  play(): void {
    if (this.playing || this.notes.length === 0) return;
    const ctx = this.ensureContext();
    if (this.anchorPosition >= this.duration) this.anchorPosition = 0;

    this.anchorCtxTime = ctx.currentTime;
    this.cursor = this.findFirstNoteAtOrAfter(this.anchorPosition);
    this.playing = true;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.anchorPosition = this.position;
    this.playing = false;
    this.clearTimer();
    this.silence();
    this.emit();
  }

  stop(): void {
    this.playing = false;
    this.clearTimer();
    this.silence();
    this.anchorPosition = 0;
    this.cursor = 0;
    this.emit();
  }

  seek(seconds: number): void {
    const target = Math.max(0, Math.min(this.duration, seconds));
    const wasPlaying = this.playing;
    if (wasPlaying) {
      this.clearTimer();
      this.silence();
    }
    this.anchorPosition = target;
    this.cursor = this.findFirstNoteAtOrAfter(target);
    if (wasPlaying && this.ctx) {
      this.anchorCtxTime = this.ctx.currentTime;
      this.timer = window.setInterval(() => this.tick(), TICK_MS);
    }
    this.emit();
  }

  /** 1 = written tempo, 0.5 = half speed. Keeps the current position. */
  setRate(rate: number): void {
    const next = Math.max(0.25, Math.min(2, rate));
    if (this.playing && this.ctx) {
      this.anchorPosition = this.position;
      this.anchorCtxTime = this.ctx.currentTime;
      this.silence();
      this.cursor = this.findFirstNoteAtOrAfter(this.anchorPosition);
    }
    this.rate = next;
  }

  get playbackRate(): number {
    return this.rate;
  }

  setVolume(value: number): void {
    this.volume = value;
    this.synth?.setVolume(value);
  }

  setStaffMuted(staffIndex: number, muted: boolean): void {
    if (muted) this.mutedStaves.add(staffIndex);
    else this.mutedStaves.delete(staffIndex);
  }

  /** Route to an external MIDI device; pass null to return to the built-in synth. */
  useMidiOutput(output: MidiOutputLike | null): void {
    this.midiSink?.dispose();
    this.midiSink = output ? new MidiOutSink(output, this.ensureContext()) : null;
  }

  get sink(): OutputSink | null {
    return this.midiSink ?? this.synth;
  }

  /** Sound one note immediately, for a key tapped on the keyboard view. */
  preview(midi: number, duration = 0.7): void {
    const ctx = this.ensureContext();
    this.sink?.noteOn(midi, ctx.currentTime, duration, 0.8);
  }

  private tick(): void {
    if (!this.playing || !this.ctx) return;
    const position = this.position;

    if (position >= this.duration) {
      this.anchorPosition = this.duration;
      this.playing = false;
      this.clearTimer();
      this.emit();
      return;
    }

    const horizon = position + LOOKAHEAD_SECONDS * this.rate;
    const sink = this.sink;

    while (this.cursor < this.notes.length && this.notes[this.cursor].start < horizon) {
      const note = this.notes[this.cursor++];
      if (this.mutedStaves.has(note.staffIndex)) continue;
      const when = this.anchorCtxTime + (note.start - this.anchorPosition) / this.rate;
      sink?.noteOn(
        note.midi,
        Math.max(this.ctx.currentTime, when),
        note.duration / this.rate,
        note.velocity,
      );
    }

    this.emit();
  }

  private findFirstNoteAtOrAfter(seconds: number): number {
    let lo = 0;
    let hi = this.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.notes[mid].start < seconds) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private silence(): void {
    this.synth?.allOff();
    this.midiSink?.allOff();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private emit(): void {
    this.onUpdate?.(this.state);
  }

  dispose(): void {
    this.stop();
    this.synth?.dispose();
    this.midiSink?.dispose();
    void this.ctx?.close();
    this.ctx = null;
  }
}

/** Enumerate OS/external MIDI destinations, if the browser exposes Web MIDI. */
export async function listMidiOutputs(): Promise<MidiOutputLike[]> {
  const request = (navigator as any).requestMIDIAccess;
  if (typeof request !== 'function') return [];
  try {
    const access = await request.call(navigator, { sysex: false });
    return Array.from(access.outputs.values()) as MidiOutputLike[];
  } catch {
    return [];
  }
}
