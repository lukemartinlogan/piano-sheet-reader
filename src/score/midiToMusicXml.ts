/**
 * MIDI -> MusicXML.
 *
 * A MIDI file records *when keys went down*; a score records *what was written*.
 * Everything between the two is a guess, and this module is where the guessing
 * is kept: quantising a performance onto a metrical grid, splitting one stream
 * of notes into two hands, spelling a pitch class as a letter plus an
 * accidental, and cutting held notes into printable note values joined by ties.
 *
 * The output goes through exactly the same path as a dropped .musicxml file, so
 * the renderer, the letter guide and the parser stay unaware that MIDI exists.
 */
import { parseMidiFile } from './midiFile';

/** MusicXML <divisions> per quarter note. 24 keeps every value we emit integral. */
const DIVISIONS = 24;
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

/** A chord clipped to a single measure; `tie*` mark where it was cut. */
interface Segment {
  start: number;
  length: number;
  midis: number[];
  tieStop: boolean;
  tieStart: boolean;
}

interface MeasureSpec {
  start: number;
  length: number;
  numerator: number;
  denominator: number;
  fifths: number;
  showTime: boolean;
  showKey: boolean;
}

interface Element {
  kind: 'note' | 'rest';
  start: number;
  units: number;
  type: string;
  dots: number;
  midis: number[];
  tieStart: boolean;
  tieStop: boolean;
  /** One entry per beam level, e.g. ['begin', 'begin'] for the first of a 16th run. */
  beams: string[];
  wholeMeasure: boolean;
}

/**
 * Printable note values, longest first, in DIVISIONS units.
 *
 * Durations are decomposed greedily against this table and the pieces tied
 * together, which is what lets an arbitrary held MIDI note become notation.
 */
const NOTE_VALUES: { units: number; type: string; dots: number }[] = [
  { units: 144, type: 'whole', dots: 1 },
  { units: 96, type: 'whole', dots: 0 },
  { units: 72, type: 'half', dots: 1 },
  { units: 48, type: 'half', dots: 0 },
  { units: 36, type: 'quarter', dots: 1 },
  { units: 24, type: 'quarter', dots: 0 },
  { units: 18, type: 'eighth', dots: 1 },
  { units: 12, type: 'eighth', dots: 0 },
  { units: 9, type: '16th', dots: 1 },
  { units: 6, type: '16th', dots: 0 },
  { units: 3, type: '32nd', dots: 0 },
];
/** A dotted rest reads as an off-beat unless it is placed with care; skip them. */
const REST_VALUES = NOTE_VALUES.filter((value) => value.dots === 0);
const BEAM_COUNT: Record<string, number> = { eighth: 1, '16th': 2, '32nd': 3 };

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_SEMITONE = [0, 2, 4, 5, 7, 9, 11];
/** Letter indices in the order accidentals are added to a key signature. */
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F
const ACCIDENTAL_NAMES: Record<number, string> = {
  [-2]: 'flat-flat',
  [-1]: 'flat',
  0: 'natural',
  1: 'sharp',
  2: 'sharp-sharp',
};

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
    return { start, length: end - start, midi: note.midi, staff: 1, track: note.track, channel: note.channel };
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

  const clefs = chooseClefs(notes, staffCount);
  const title = midi.name || stripExtension(filename);
  return serialise({ measures, perStaff, staffCount, clefs, tempos, title, copyright: midi.copyright });
}

/** Grid step in DIVISIONS units, clamped to values the note table can express. */
function gridUnits(denominator: number): number {
  const wanted = DIVISIONS / Math.max(1, denominator);
  const allowed = [24, 12, 6, 3];
  return allowed.find((step) => step <= wanted) ?? 3;
}

function measureUnits(numerator: number, denominator: number): number {
  const beat = (DIVISIONS * 4) / denominator;
  if (!Number.isInteger(beat) || beat <= 0) return DIVISIONS * 4;
  return Math.max(beat, Math.round(numerator * beat));
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

/** Cut chords at barlines, marking the joins so they can be re-tied. */
function splitAcrossMeasures(chords: Chord[], measures: MeasureSpec[]): Segment[][] {
  const perMeasure: Segment[][] = measures.map(() => []);
  for (const chord of chords) {
    let position = chord.start;
    let remaining = chord.length;
    let index = measureIndexAt(measures, position);
    while (remaining > 0 && index < measures.length) {
      const measure = measures[index];
      const take = Math.min(remaining, measure.start + measure.length - position);
      if (take <= 0) break;
      perMeasure[index].push({
        start: position - measure.start,
        length: take,
        midis: chord.midis,
        tieStop: position > chord.start,
        tieStart: take < remaining,
      });
      position += take;
      remaining -= take;
      index++;
    }
  }
  for (const segments of perMeasure) segments.sort((a, b) => a.start - b.start);
  return perMeasure;
}

function measureIndexAt(measures: MeasureSpec[], units: number): number {
  let lo = 0;
  let hi = measures.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measures[mid].start <= units) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Greedy decomposition into printable values; the caller ties the pieces. */
function decompose(length: number, values: typeof NOTE_VALUES): typeof NOTE_VALUES {
  const pieces: typeof NOTE_VALUES = [];
  let remaining = length;
  let guard = 0;
  while (remaining > 0 && guard++ < 64) {
    const value = values.find((candidate) => candidate.units <= remaining);
    if (!value) break;
    pieces.push(value);
    remaining -= value.units;
  }
  return pieces;
}

/** Turn one measure of one staff into the note/rest elements to print. */
function layOutMeasure(segments: Segment[], measure: MeasureSpec): Element[] {
  const elements: Element[] = [];

  const addRests = (from: number, to: number) => {
    let position = from;
    while (position < to) {
      // Rests are aligned to the beat they start on, so the metre stays legible.
      const room = to - position;
      const value =
        REST_VALUES.find((candidate) => candidate.units <= room && position % candidate.units === 0) ??
        REST_VALUES.find((candidate) => candidate.units <= room);
      if (!value) break;
      elements.push(makeElement('rest', position, value, [], false, false));
      position += value.units;
    }
  };

  let cursor = 0;
  for (const segment of segments) {
    if (segment.start > cursor) addRests(cursor, segment.start);
    if (segment.start < cursor) continue; // fully covered by an earlier segment
    const pieces = decompose(segment.length, NOTE_VALUES);
    let position = segment.start;
    pieces.forEach((piece, index) => {
      elements.push(
        makeElement(
          'note',
          position,
          piece,
          segment.midis,
          segment.tieStart || index < pieces.length - 1,
          segment.tieStop || index > 0,
        ),
      );
      position += piece.units;
    });
    cursor = position;
  }
  if (cursor < measure.length) addRests(cursor, measure.length);

  if (elements.length === 1 && elements[0].kind === 'rest' && elements[0].units === measure.length) {
    elements[0].wholeMeasure = true;
  }
  addBeams(elements, measure);
  return elements;
}

function makeElement(
  kind: 'note' | 'rest',
  start: number,
  value: { units: number; type: string; dots: number },
  midis: number[],
  tieStart: boolean,
  tieStop: boolean,
): Element {
  return {
    kind,
    start,
    units: value.units,
    type: value.type,
    dots: value.dots,
    midis,
    tieStart,
    tieStop,
    beams: [],
    wholeMeasure: false,
  };
}

/**
 * Beam runs of short notes within a beat.
 *
 * Without this OSMD draws every eighth with its own flag, which turns a bar of
 * running notes into a picket fence and hides the beat entirely.
 */
function addBeams(elements: Element[], measure: MeasureSpec): void {
  // Compound metres group by the dotted beat; everything else by the quarter.
  const groupUnits =
    measure.denominator === 8 && measure.numerator % 3 === 0 ? 36 : DIVISIONS;

  let run: Element[] = [];
  const flush = () => {
    if (run.length >= 2) {
      run.forEach((element, index) => {
        const levels = BEAM_COUNT[element.type] ?? 0;
        const before = index > 0 ? BEAM_COUNT[run[index - 1].type] ?? 0 : 0;
        const after = index < run.length - 1 ? BEAM_COUNT[run[index + 1].type] ?? 0 : 0;
        for (let level = 1; level <= levels; level++) {
          const linkedBefore = before >= level;
          const linkedAfter = after >= level;
          if (linkedBefore && linkedAfter) element.beams.push('continue');
          else if (!linkedBefore && linkedAfter) element.beams.push('begin');
          else if (linkedBefore && !linkedAfter) element.beams.push('end');
          // A level nobody else shares is a hook, pointing back into the run.
          else element.beams.push(index === 0 ? 'forward hook' : 'backward hook');
        }
      });
    }
    run = [];
  };

  for (const element of elements) {
    const beamable = element.kind === 'note' && (BEAM_COUNT[element.type] ?? 0) > 0;
    const sameGroup =
      run.length > 0 && Math.floor(element.start / groupUnits) === Math.floor(run[0].start / groupUnits);
    if (!beamable || !sameGroup) flush();
    if (beamable) run.push(element);
  }
  flush();
}

// ------------------------------------------------------------ spelling ---

/** Which letters the key signature alters, indexed C..B. */
function keyAlterations(fifths: number): number[] {
  const alters = [0, 0, 0, 0, 0, 0, 0];
  const order = fifths >= 0 ? SHARP_ORDER : FLAT_ORDER;
  for (let i = 0; i < Math.min(7, Math.abs(fifths)); i++) {
    alters[order[i]] = fifths >= 0 ? 1 : -1;
  }
  return alters;
}

/**
 * Spell a MIDI pitch as letter + alteration in a given key.
 *
 * Diatonic pitches take their spelling from the key signature, so B flat in F
 * major prints as B flat rather than A sharp; chromatic ones lean the way the
 * key does. The octave is derived from the letter, not the pitch class, so B
 * sharp stays in the octave its letter belongs to.
 */
function spell(midi: number, fifths: number): { step: string; alter: number; octave: number } {
  const alters = keyAlterations(fifths);
  const pitchClass = ((midi % 12) + 12) % 12;

  let letter = -1;
  let alter = 0;
  for (let i = 0; i < 7; i++) {
    if ((((LETTER_SEMITONE[i] + alters[i]) % 12) + 12) % 12 === pitchClass) {
      letter = i;
      alter = alters[i];
      break;
    }
  }
  if (letter < 0) {
    const direction = fifths >= 0 ? 1 : -1;
    for (let i = 0; i < 7; i++) {
      if ((((LETTER_SEMITONE[i] + alters[i] + direction) % 12) + 12) % 12 === pitchClass) {
        letter = i;
        alter = alters[i] + direction;
        break;
      }
    }
  }
  if (letter < 0) {
    letter = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6][pitchClass];
    alter = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0][pitchClass];
  }

  const octave = Math.round((midi - LETTER_SEMITONE[letter] - alter) / 12) - 1;
  return { step: LETTERS[letter], alter, octave };
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

// --------------------------------------------------------- serialising ---

interface ScoreParts {
  measures: MeasureSpec[];
  perStaff: Segment[][][];
  staffCount: number;
  clefs: { sign: string; line: number }[];
  tempos: { units: number; bpm: number }[];
  title: string;
  copyright: string;
}

function serialise(score: ScoreParts): string {
  const { measures, perStaff, staffCount, clefs, tempos, title } = score;
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<score-partwise version="4.0">');
  lines.push('  <work>');
  lines.push(`    <work-title>${escapeXml(title)}</work-title>`);
  lines.push('  </work>');
  lines.push('  <identification>');
  if (score.copyright) lines.push(`    <rights>${escapeXml(score.copyright)}</rights>`);
  lines.push('    <encoding>');
  lines.push('      <software>Sheet Reader MIDI import</software>');
  lines.push('    </encoding>');
  lines.push('  </identification>');
  lines.push('  <part-list>');
  lines.push('    <score-part id="P1">');
  lines.push('      <part-name>Piano</part-name>');
  lines.push('    </score-part>');
  lines.push('  </part-list>');
  lines.push('  <part id="P1">');

  // Tempo marks are bucketed per measure so they can be interleaved in order.
  const tempoByMeasure = bucketTempos(tempos, measures);
  let previousFifths = measures[0]?.fifths ?? 0;

  measures.forEach((measure, index) => {
    lines.push(`    <measure number="${index + 1}">`);

    if (index === 0 || measure.showKey || measure.showTime) {
      lines.push('      <attributes>');
      if (index === 0) lines.push(`        <divisions>${DIVISIONS}</divisions>`);
      if (index === 0 || (measure.showKey && measure.fifths !== previousFifths)) {
        lines.push('        <key>');
        lines.push(`          <fifths>${measure.fifths}</fifths>`);
        lines.push('        </key>');
      }
      if (index === 0 || measure.showTime) {
        lines.push('        <time>');
        lines.push(`          <beats>${measure.numerator}</beats>`);
        lines.push(`          <beat-type>${measure.denominator}</beat-type>`);
        lines.push('        </time>');
      }
      if (index === 0) {
        lines.push(`        <staves>${staffCount}</staves>`);
        clefs.forEach((clef, staff) => {
          lines.push(`        <clef number="${staff + 1}">`);
          lines.push(`          <sign>${clef.sign}</sign>`);
          lines.push(`          <line>${clef.line}</line>`);
          lines.push('        </clef>');
        });
      }
      lines.push('      </attributes>');
    }
    previousFifths = measure.fifths;

    for (let staff = 1; staff <= staffCount; staff++) {
      if (staff > 1) {
        lines.push('      <backup>');
        lines.push(`        <duration>${measure.length}</duration>`);
        lines.push('      </backup>');
      }
      const elements = layOutMeasure(perStaff[staff - 1][index] ?? [], measure);
      // Only the first staff carries the tempo marks; a second copy would be
      // read as a second tempo change at the same spot.
      const pending = staff === 1 ? [...(tempoByMeasure[index] ?? [])] : [];
      const accidentals = new Map<string, number>();

      for (const element of elements) {
        while (pending.length > 0 && pending[0].units <= element.start) {
          lines.push(...renderTempo(pending.shift()!));
        }
        lines.push(...renderElement(element, staff, measure.fifths, accidentals));
      }
      for (const tempo of pending) lines.push(...renderTempo(tempo));
    }

    if (index === measures.length - 1) {
      lines.push('      <barline location="right">');
      lines.push('        <bar-style>light-heavy</bar-style>');
      lines.push('      </barline>');
    }
    lines.push('    </measure>');
  });

  lines.push('  </part>');
  lines.push('</score-partwise>');
  return lines.join('\n');
}

interface TempoMark {
  units: number;
  bpm: number;
  visible: boolean;
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
      lastVisibleBpm === 0 || (authored && Math.abs(tempo.bpm - lastVisibleBpm) / lastVisibleBpm >= 0.05);
    if (visible) lastVisibleBpm = tempo.bpm;
    buckets[index].push({ units: tempo.units - measures[index].start, bpm: tempo.bpm, visible });
  }
  return buckets;
}

function renderTempo(tempo: TempoMark): string[] {
  const bpm = Math.round(tempo.bpm * 100) / 100;
  if (!tempo.visible) {
    // Timing only: <sound> is music data, so it may sit between notes.
    return [`      <sound tempo="${bpm}"/>`];
  }
  return [
    '      <direction placement="above">',
    '        <direction-type>',
    '          <metronome parentheses="no">',
    '            <beat-unit>quarter</beat-unit>',
    `            <per-minute>${Math.round(tempo.bpm)}</per-minute>`,
    '          </metronome>',
    '        </direction-type>',
    `        <sound tempo="${bpm}"/>`,
    '      </direction>',
  ];
}

function renderElement(
  element: Element,
  staff: number,
  fifths: number,
  accidentals: Map<string, number>,
): string[] {
  if (element.kind === 'rest') {
    const lines = ['      <note>'];
    lines.push(element.wholeMeasure ? '        <rest measure="yes"/>' : '        <rest/>');
    lines.push(`        <duration>${element.units}</duration>`);
    lines.push(`        <voice>${staff}</voice>`);
    if (!element.wholeMeasure) {
      lines.push(`        <type>${element.type}</type>`);
      for (let i = 0; i < element.dots; i++) lines.push('        <dot/>');
    }
    lines.push(`        <staff>${staff}</staff>`);
    lines.push('      </note>');
    return lines;
  }

  const lines: string[] = [];
  element.midis.forEach((midi, index) => {
    const { step, alter, octave } = spell(midi, fifths);
    lines.push('      <note>');
    if (index > 0) lines.push('        <chord/>');
    lines.push('        <pitch>');
    lines.push(`          <step>${step}</step>`);
    if (alter !== 0) lines.push(`          <alter>${alter}</alter>`);
    lines.push(`          <octave>${octave}</octave>`);
    lines.push('        </pitch>');
    lines.push(`        <duration>${element.units}</duration>`);
    if (element.tieStop) lines.push('        <tie type="stop"/>');
    if (element.tieStart) lines.push('        <tie type="start"/>');
    lines.push(`        <voice>${staff}</voice>`);
    lines.push(`        <type>${element.type}</type>`);
    for (let i = 0; i < element.dots; i++) lines.push('        <dot/>');

    // An accidental is printed only where it changes what is already in force
    // for that letter in this bar — and never on the far side of a tie.
    const key = `${step}${octave}`;
    const inForce = accidentals.get(key) ?? keyAlterations(fifths)[LETTERS.indexOf(step)];
    if (alter !== inForce) {
      if (!element.tieStop) lines.push(`        <accidental>${ACCIDENTAL_NAMES[alter] ?? 'natural'}</accidental>`);
      accidentals.set(key, alter);
    }

    lines.push(`        <staff>${staff}</staff>`);
    if (index === 0) {
      element.beams.forEach((beam, level) => {
        lines.push(`        <beam number="${level + 1}">${beam}</beam>`);
      });
    }
    if (element.tieStart || element.tieStop) {
      lines.push('        <notations>');
      if (element.tieStop) lines.push('          <tied type="stop"/>');
      if (element.tieStart) lines.push('          <tied type="start"/>');
      lines.push('        </notations>');
    }
    lines.push('      </note>');
  });
  return lines;
}

const stripExtension = (filename: string): string =>
  filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
