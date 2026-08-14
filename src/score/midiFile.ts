/**
 * Standard MIDI File reader.
 *
 * This turns the byte stream into note-on/note-off pairs plus the meta events
 * that carry musical context (tempo, meter, key, names). Deciding what any of
 * it means *on a staff* is midiToMusicXml's job — a MIDI file records a
 * performance, not an engraving, and keeping the two apart stops the guesswork
 * from leaking into the parsing.
 */

/** One sounding note, matched from its note-on/note-off pair. */
export interface MidiNote {
  /** Ticks from the start of the file. */
  tick: number;
  durationTicks: number;
  midi: number;
  /** 0..1. */
  velocity: number;
  /** 0-based; channel 9 is the percussion map. */
  channel: number;
  /** Index of the track chunk the note came from. */
  track: number;
}

export interface MidiTempo {
  tick: number;
  bpm: number;
}

export interface MidiTimeSignature {
  tick: number;
  numerator: number;
  /** Already expanded from the file's log2 form: 3 in the file means 8 here. */
  denominator: number;
}

export interface MidiKeySignature {
  tick: number;
  /** Position on the circle of fifths: positive sharps, negative flats. */
  fifths: number;
  minor: boolean;
}

export interface MidiFileData {
  format: number;
  ticksPerQuarter: number;
  /** One entry per track chunk, in file order; '' when the track is unnamed. */
  trackNames: string[];
  notes: MidiNote[];
  tempos: MidiTempo[];
  timeSignatures: MidiTimeSignature[];
  keySignatures: MidiKeySignature[];
  /** Sequence name: the first track's name meta, which is the usual home for it. */
  name: string;
  copyright: string;
  /** Last tick reached by any track. */
  durationTicks: number;
}

const HEADER_MAGIC = 0x4d546864; // 'MThd'
const TRACK_MAGIC = 0x4d54726b; // 'MTrk'

/** Cheap sniff, so the loader can route a dropped file without parsing it. */
export function isMidiFile(bytes: Uint8Array): boolean {
  return (
    bytes.length > 8 &&
    bytes[0] === 0x4d &&
    bytes[1] === 0x54 &&
    bytes[2] === 0x68 &&
    bytes[3] === 0x64
  );
}

const decoder = new TextDecoder('utf-8', { fatal: false });
/** Meta text is free-form bytes; drop control characters so names stay printable. */
const printable = (value: string): string =>
  Array.from(value)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .trim();

class ByteReader {
  private pos = 0;

  constructor(
    private readonly view: DataView,
    private readonly bytes: Uint8Array,
  ) {}

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.view.byteLength - this.pos;
  }

  seek(to: number): void {
    this.pos = to;
  }

  skip(count: number): void {
    this.pos += count;
  }

  peek(): number {
    this.need(1);
    return this.view.getUint8(this.pos);
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    this.need(2);
    const value = this.view.getUint16(this.pos);
    this.pos += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.pos);
    this.pos += 4;
    return value;
  }

  /** Meta-event text. Names are usually ASCII; anything odd degrades gracefully. */
  text(length: number): string {
    this.need(length);
    const raw = decoder.decode(this.bytes.subarray(this.pos, this.pos + length));
    this.pos += length;
    return printable(raw);
  }

  readBytes(length: number): number[] {
    this.need(length);
    const out: number[] = [];
    for (let i = 0; i < length; i++) out.push(this.view.getUint8(this.pos + i));
    this.pos += length;
    return out;
  }

  /** Variable-length quantity: 7 bits per byte, high bit means "more follows". */
  varlen(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.u8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('Malformed variable-length value in the MIDI data.');
  }

  private need(count: number): void {
    if (this.pos + count > this.view.byteLength) {
      throw new Error('The MIDI file ends mid-event — it looks truncated.');
    }
  }
}

/** Parse a Standard MIDI File. Throws with a readable message on anything unusable. */
export function parseMidiFile(data: ArrayBuffer): MidiFileData {
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  const reader = new ByteReader(view, bytes);

  if (view.byteLength < 14 || reader.u32() !== HEADER_MAGIC) {
    throw new Error('Not a MIDI file (no MThd header).');
  }
  const headerLength = reader.u32();
  const format = reader.u16();
  const trackCount = reader.u16();
  const division = reader.u16();
  // Header chunks are 6 bytes today but the length field is authoritative.
  reader.seek(8 + Math.max(6, headerLength));

  if (division & 0x8000) {
    throw new Error(
      'This MIDI file is SMPTE-timed (frames, not beats), which carries no bar or beat information to engrave.',
    );
  }
  if (division === 0) throw new Error('This MIDI file declares zero ticks per quarter note.');

  const notes: MidiNote[] = [];
  const tempos: MidiTempo[] = [];
  const timeSignatures: MidiTimeSignature[] = [];
  const keySignatures: MidiKeySignature[] = [];
  const trackNames: string[] = [];
  let copyright = '';
  let durationTicks = 0;

  for (let track = 0; track < trackCount && reader.remaining >= 8; track++) {
    const magic = reader.u32();
    const length = reader.u32();
    const end = Math.min(reader.offset + length, view.byteLength);
    if (magic !== TRACK_MAGIC) {
      // Unknown chunk types are skippable by design.
      reader.seek(end);
      trackNames.push('');
      continue;
    }

    trackNames.push('');
    readTrack(reader, end, track, {
      notes,
      tempos,
      timeSignatures,
      keySignatures,
      onName: (name) => {
        if (!trackNames[track]) trackNames[track] = name;
      },
      onCopyright: (value) => {
        if (!copyright) copyright = value;
      },
      onEndTick: (tick) => {
        if (tick > durationTicks) durationTicks = tick;
      },
    });
    reader.seek(end);
  }

  if (notes.length === 0) throw new Error('This MIDI file contains no notes.');

  notes.sort((a, b) => a.tick - b.tick || a.midi - b.midi);
  tempos.sort((a, b) => a.tick - b.tick);
  timeSignatures.sort((a, b) => a.tick - b.tick);
  keySignatures.sort((a, b) => a.tick - b.tick);

  return {
    format,
    ticksPerQuarter: division,
    trackNames,
    notes,
    tempos,
    timeSignatures,
    keySignatures,
    name: trackNames.find((n) => n.length > 0) ?? '',
    copyright,
    durationTicks,
  };
}

interface TrackSink {
  notes: MidiNote[];
  tempos: MidiTempo[];
  timeSignatures: MidiTimeSignature[];
  keySignatures: MidiKeySignature[];
  onName: (name: string) => void;
  onCopyright: (value: string) => void;
  onEndTick: (tick: number) => void;
}

function readTrack(reader: ByteReader, end: number, track: number, sink: TrackSink): void {
  let tick = 0;
  let runningStatus = 0;
  /** Sounding notes keyed by channel/pitch; a repeated pitch stacks, oldest off first. */
  const open = new Map<number, MidiNote[]>();

  const closeNote = (channel: number, midi: number, at: number): void => {
    const key = channel * 128 + midi;
    const stack = open.get(key);
    const note = stack?.shift();
    if (!note) return;
    note.durationTicks = Math.max(1, at - note.tick);
    if (stack && stack.length === 0) open.delete(key);
  };

  while (reader.offset < end) {
    tick += reader.varlen();
    if (reader.offset >= end) break;

    let status = reader.peek();
    if (status & 0x80) {
      reader.skip(1);
      // System messages cancel running status rather than becoming it.
      runningStatus = status < 0xf0 ? status : 0;
    } else {
      status = runningStatus;
      if (!status) throw new Error('MIDI track data begins without a status byte.');
    }

    if (status === 0xff) {
      const type = reader.u8();
      const length = reader.varlen();
      const at = reader.offset;
      switch (type) {
        case 0x01:
        case 0x03:
          sink.onName(reader.text(length));
          break;
        case 0x02:
          sink.onCopyright(reader.text(length));
          break;
        case 0x51: {
          const d = reader.readBytes(length);
          const microsPerQuarter = ((d[0] ?? 0) << 16) | ((d[1] ?? 0) << 8) | (d[2] ?? 0);
          if (microsPerQuarter > 0) sink.tempos.push({ tick, bpm: 60000000 / microsPerQuarter });
          break;
        }
        case 0x58: {
          const d = reader.readBytes(length);
          const numerator = d[0] ?? 4;
          const denominator = 2 ** (d[1] ?? 2);
          if (numerator > 0 && denominator > 0) {
            sink.timeSignatures.push({ tick, numerator, denominator });
          }
          break;
        }
        case 0x59: {
          const d = reader.readBytes(length);
          // sf is signed: 0xff is one flat, not 255.
          const raw = d[0] ?? 0;
          const fifths = raw > 127 ? raw - 256 : raw;
          if (fifths >= -7 && fifths <= 7) {
            sink.keySignatures.push({ tick, fifths, minor: (d[1] ?? 0) === 1 });
          }
          break;
        }
        case 0x2f:
          sink.onEndTick(tick);
          reader.seek(end);
          break;
        default:
          break;
      }
      reader.seek(at + length);
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const length = reader.varlen();
      reader.skip(length);
      continue;
    }

    const command = status & 0xf0;
    const channel = status & 0x0f;
    switch (command) {
      case 0x80: {
        const midi = reader.u8();
        reader.u8();
        closeNote(channel, midi, tick);
        break;
      }
      case 0x90: {
        const midi = reader.u8();
        const velocity = reader.u8();
        // A note-on with zero velocity is the idiomatic note-off.
        if (velocity === 0) {
          closeNote(channel, midi, tick);
          break;
        }
        const note: MidiNote = {
          tick,
          durationTicks: 1,
          midi,
          velocity: velocity / 127,
          channel,
          track,
        };
        sink.notes.push(note);
        const key = channel * 128 + midi;
        const stack = open.get(key);
        if (stack) stack.push(note);
        else open.set(key, [note]);
        break;
      }
      case 0xa0:
      case 0xb0:
      case 0xe0:
        reader.skip(2);
        break;
      case 0xc0:
      case 0xd0:
        reader.skip(1);
        break;
      default:
        throw new Error(`Unrecognised MIDI status byte 0x${status.toString(16)}.`);
    }
    sink.onEndTick(tick);
  }

  // A track that stops without releasing its notes still has to produce sound.
  for (const stack of open.values()) {
    for (const note of stack) note.durationTicks = Math.max(1, tick - note.tick);
  }
}
