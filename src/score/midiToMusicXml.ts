/**
 * MIDI -> MusicXML.
 *
 * A MIDI file records *when keys went down*; a score records *what was written*.
 * Everything between the two is a guess, and this module is where the guessing
 * is kept: quantising a performance onto a metrical grid, splitting one stream
 * of notes into two hands, and inferring a key to spell against. Turning the
 * result into notation is musicXmlWriter's job, shared with the PDF importer.
 *
 * The output goes through exactly the same path as a dropped .musicxml file, so
 * the renderer, the letter guide and the parser stay unaware that MIDI exists.
 */
import { parseMidiFile } from './midiFile';
import {
  DIVISIONS,
  measureIndexAt,
  measureUnits,
  splitAcrossMeasures,
  writeMusicXml,
  type MeasureSpec,
  type Segment,
  type TempoMark,
} from './musicXmlWriter';

/** Safety rail: a corrupt tempo/meter map must not spin out a million bars. */
const MAX_MEASURES = 4000;

export interface MidiImportOptions {
  /**
   * Onset grid as a fraction of a quarter note: 4 (the default) snaps everything
   * to sixteenths. Finer grids keep more of the performance and print worse.
   */
  gridDenominator?: number;
  /** MIDI pitch at and above which a note is written on the upper staff. */
  splitPoint?: number;
}

/** A note after quantisation. Times are in DIVISIONS units from the first bar. */
interface GridNote {
  start: number;
  length: number;
  midi: number;
  staff: number;
  track: number;
  channel: number;
}

/** Notes struck together, collapsed into one printable event. */
interface Chord {
  start: number;
  length: number;
  midis: number[];
}

/**
 * Convert a Standard MIDI File into MusicXML that OSMD can engrave.
 *
 * `filename` is only used for the title and for error messages.
 */
export function midiToMusicXml(
  data: ArrayBuffer,
  filename: string,
  options: MidiImportOptions = {},
): string {
  const midi = parseMidiFile(data);
  const grid = gridUnits(options.gridDenominator ?? 4);
  const scale = DIVISIONS / midi.ticksPerQuarter;
  const snap = (units: number) => Math.round(units / grid) * grid;

  // Channel 10 is the percussion map: its "pitches" are drum names, not notes.
  const pitched = midi.notes.filter((note) => note.channel !== 9);
  if (pitched.length === 0) {
    throw new Error(
      `${filename} contains only percussion (channel 10), which has no pitch to write on a staff.`,
    );
  }

  const notes: GridNote[] = pitched.map((note) => {
    const start = snap(note.tick * scale);
    const end = Math.max(start + grid, snap((note.tick + note.durationTicks) * scale));
    return {
      start,
      length: end - start,
      midi: note.midi,
      staff: 1,
      track: note.track,
      channel: note.channel,
    };
  });

  // Drop whole empty bars of lead-in, which sequencers add as a count-off.
  const firstSig = midi.timeSignatures[0];
  const leadBar = measureUnits(firstSig?.numerator ?? 4, firstSig?.denominator ?? 4);
  const firstStart = notes.reduce((min, note) => Math.min(min, note.start), Infinity);
  const offset = Math.max(0, Math.floor(firstStart / leadBar) * leadBar);
  for (const note of notes) note.start -= offset;

  const shift = (tick: number) => Math.max(0, snap(tick * scale) - offset);
  const tempos = midi.tempos.map((t) => ({ units: shift(t.tick), bpm: t.bpm }));
  const timeSigs = midi.timeSignatures.map((t) => ({
    units: shift(t.tick),
    numerator: t.numerator,
    denominator: t.denominator,
  }));
  const keySigs = midi.keySignatures.map((k) => ({ units: shift(k.tick), fifths: k.fifths }));
  if (keySigs.length === 0) keySigs.push({ units: 0, fifths: detectKey(notes) });

  const staffCount = assignStaves(notes, options.splitPoint ?? 60);
  const totalUnits = notes.reduce((max, note) => Math.max(max, note.start + note.length), 0);
  const measures = buildMeasures(timeSigs, keySigs, totalUnits);

  // One voice per staff: chords are collapsed and overlaps are clipped, so each
  // staff reads as a single line. Two-voice writing is a different feature.
  const perStaff: Segment[][][] = [];
  for (let staff = 1; staff <= staffCount; staff++) {
    const chords = buildChords(notes.filter((note) => note.staff === staff));
    perStaff.push(splitAcrossMeasures(chords, measures));
  }

  return writeMusicXml({
    measures,
    perStaff,
    staffCount,
    clefs: chooseClefs(notes, staffCount),
    tempos: bucketTempos(tempos, measures),
    title: midi.name || stripExtension(filename),
    copyright: midi.copyright,
  });
}

/** Grid step in DIVISIONS units, clamped to values the note table can express. */
function gridUnits(denominator: number): number {
  const wanted = DIVISIONS / Math.max(1, denominator);
  const allowed = [24, 12, 6, 3];
  return allowed.find((step) => step <= wanted) ?? 3;
}

// ---------------------------------------------------------------- hands ---

/**
 * Decide which staff each note belongs to, and return how many staves resulted.
 *
 * A file that already separates the hands (two tracks, or two channels) is taken
 * at its word — that is the composer's own split. Everything else falls back to
 * a pitch split at middle C, which is where a pianist would put it.
 */
function assignStaves(notes: GridNote[], splitPoint: number): number {
  const byTrack = groupBy(notes, (note) => note.track);
  const groups = byTrack.length >= 2 ? byTrack : groupBy(notes, (note) => note.channel);

  const substantial = groups.filter((group) => group.length >= notes.length * 0.05);
  if (substantial.length === 2) {
    const upper =
      meanPitch(substantial[0]) >= meanPitch(substantial[1]) ? substantial[0] : substantial[1];
    const upperSet = new Set(upper);
    for (const note of notes) note.staff = upperSet.has(note) ? 1 : 2;
    // Notes from any group too small to be a hand join the nearer staff.
    for (const group of groups) {
      if (substantial.includes(group)) continue;
      for (const note of group) note.staff = note.midi >= splitPoint ? 1 : 2;
    }
  } else {
    for (const note of notes) note.staff = note.midi >= splitPoint ? 1 : 2;
  }

  const upperCount = notes.filter((note) => note.staff === 1).length;
  if (upperCount === 0 || upperCount === notes.length) {
    // Everything landed in one hand: a single staff, rather than an empty one.
    for (const note of notes) note.staff = 1;
    return 1;
  }
  return 2;
}

function chooseClefs(notes: GridNote[], staffCount: number): { sign: string; line: number }[] {
  if (staffCount === 2) {
    return [
      { sign: 'G', line: 2 },
      { sign: 'F', line: 4 },
    ];
  }
  return [meanPitch(notes) >= 57 ? { sign: 'G', line: 2 } : { sign: 'F', line: 4 }];
}

function groupBy<T>(items: T[], key: (item: T) => number): T[][] {
  const buckets = new Map<number, T[]>();
  for (const item of items) {
    const id = key(item);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(item);
    else buckets.set(id, [item]);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, bucket]) => bucket);
}

const meanPitch = (notes: GridNote[]): number =>
  notes.length === 0 ? 60 : notes.reduce((sum, note) => sum + note.midi, 0) / notes.length;

// ------------------------------------------------------------- metre ---

function buildMeasures(
  timeSigs: { units: number; numerator: number; denominator: number }[],
  keySigs: { units: number; fifths: number }[],
  totalUnits: number,
): MeasureSpec[] {
  const measures: MeasureSpec[] = [];
  let numerator = timeSigs[0]?.numerator ?? 4;
  let denominator = timeSigs[0]?.denominator ?? 4;
  let fifths = keySigs[0]?.fifths ?? 0;
  let timeIndex = 0;
  let keyIndex = 0;
  let position = 0;

  while (position < totalUnits || measures.length === 0) {
    // A signature change only takes effect at the next barline.
    let showTime = measures.length === 0;
    while (timeIndex < timeSigs.length && timeSigs[timeIndex].units <= position) {
      const sig = timeSigs[timeIndex++];
      if (sig.numerator !== numerator || sig.denominator !== denominator) {
        numerator = sig.numerator;
        denominator = sig.denominator;
        showTime = true;
      }
    }
    let showKey = measures.length === 0;
    while (keyIndex < keySigs.length && keySigs[keyIndex].units <= position) {
      const key = keySigs[keyIndex++];
      if (key.fifths !== fifths) {
        fifths = key.fifths;
        showKey = true;
      }
    }

    const length = measureUnits(numerator, denominator);
    measures.push({ start: position, length, numerator, denominator, fifths, showTime, showKey });
    position += length;
    if (measures.length >= MAX_MEASURES) break;
  }
  return measures;
}

// ------------------------------------------------------------ shaping ---

/**
 * Collapse simultaneous notes into chords and clip each chord at the next onset.
 *
 * Clipping is what keeps a staff to one voice: a bass note held under a run
 * would otherwise need a second voice to be written at its true length.
 */
function buildChords(notes: GridNote[]): Chord[] {
  const byStart = new Map<number, GridNote[]>();
  for (const note of notes) {
    const bucket = byStart.get(note.start);
    if (bucket) bucket.push(note);
    else byStart.set(note.start, [note]);
  }

  const chords: Chord[] = [...byStart.keys()]
    .sort((a, b) => a - b)
    .map((start) => {
      const members = byStart.get(start)!;
      const midis = [...new Set(members.map((note) => note.midi))].sort((a, b) => a - b);
      // The longest member wins: a chord under a melody should ring, not clip.
      const length = members.reduce((max, note) => Math.max(max, note.length), 0);
      return { start, length, midis };
    });

  for (let i = 0; i < chords.length - 1; i++) {
    chords[i].length = Math.min(chords[i].length, chords[i + 1].start - chords[i].start);
  }
  return chords;
}

/**
 * Guess the key when the file does not say, so the spelling has something to
 * lean on. Weighted by sounding length against the Krumhansl tone profiles —
 * crude, but far better than defaulting everything to sharps in a flat key.
 */
function detectKey(notes: GridNote[]): number {
  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  /** Key signature of the major key on each pitch class, C first. */
  const FIFTHS_OF = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];

  const weight = new Array<number>(12).fill(0);
  for (const note of notes) weight[((note.midi % 12) + 12) % 12] += note.length;
  const total = weight.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;

  let best = 0;
  let bestScore = -Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [profile, relative] of [
      [MAJOR, 0],
      [MINOR, 3],
    ] as const) {
      let score = 0;
      for (let i = 0; i < 12; i++) score += (weight[(tonic + i) % 12] / total) * profile[i];
      if (score > bestScore) {
        bestScore = score;
        best = FIFTHS_OF[(tonic + relative) % 12];
      }
    }
  }
  return best;
}

/**
 * Group tempo marks by measure, dropping repeats.
 *
 * A performance-derived file can carry a tempo change every beat; those are
 * kept because they are what makes quantised notes sound human again, but only
 * a sparse, authored-looking tempo map is worth *printing*.
 */
function bucketTempos(
  tempos: { units: number; bpm: number }[],
  measures: MeasureSpec[],
): TempoMark[][] {
  const buckets: TempoMark[][] = measures.map(() => []);
  const authored = tempos.length <= 32;
  let lastBpm = 0;
  let lastVisibleBpm = 0;

  const marks = tempos.length > 0 ? tempos : [{ units: 0, bpm: 120 }];
  if (marks[0].units > 0) marks.unshift({ units: 0, bpm: marks[0].bpm });

  for (const tempo of marks) {
    if (Math.abs(tempo.bpm - lastBpm) < 0.1) continue;
    lastBpm = tempo.bpm;
    const index = measureIndexAt(measures, tempo.units);
    const visible =
      lastVisibleBpm === 0 ||
      (authored && Math.abs(tempo.bpm - lastVisibleBpm) / lastVisibleBpm >= 0.05);
    if (visible) lastVisibleBpm = tempo.bpm;
    buckets[index].push({ units: tempo.units - measures[index].start, bpm: tempo.bpm, visible });
  }
  return buckets;
}

const stripExtension = (filename: string): string =>
  filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
