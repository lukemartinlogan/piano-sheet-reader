/**
 * MusicXML output.
 *
 * Both importers — MIDI and PDF — end up with the same thing: measures, and per
 * staff per measure a list of chords with a start and a length. Turning that
 * into notation is the same job either way (cutting durations into printable
 * note values joined by ties, filling the gaps with rests, spelling pitches
 * against the key, beaming runs within a beat), so it lives here once rather
 * than twice.
 *
 * What each importer keeps for itself is the part that is genuinely its own:
 * *recovering* those chords from a performance, or from an engraving.
 */

/** MusicXML <divisions> per quarter note. 24 keeps every value we emit integral. */
export const DIVISIONS = 24;

/** A chord occupying one measure of one staff; `tie*` mark where it was cut. */
export interface Segment {
  /** Offset from the start of its measure, in DIVISIONS units. */
  start: number;
  length: number;
  midis: number[];
  tieStop: boolean;
  tieStart: boolean;
}

export interface MeasureSpec {
  /** Offset from the start of the piece, in DIVISIONS units. */
  start: number;
  length: number;
  numerator: number;
  denominator: number;
  fifths: number;
  showTime: boolean;
  showKey: boolean;
}

export interface TempoMark {
  /** Offset from the start of its measure, in DIVISIONS units. */
  units: number;
  bpm: number;
  visible: boolean;
}

export interface WriterScore {
  measures: MeasureSpec[];
  /** Indexed [staff][measure] -> the chords in it. */
  perStaff: Segment[][][];
  staffCount: number;
  clefs: { sign: string; line: number }[];
  /** Indexed by measure. */
  tempos: TempoMark[][];
  title: string;
  copyright: string;
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
 * together, which is what lets an arbitrary held note become notation.
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

/** Length of one measure of the given metre, in DIVISIONS units. */
export function measureUnits(numerator: number, denominator: number): number {
  const beat = (DIVISIONS * 4) / denominator;
  if (!Number.isInteger(beat) || beat <= 0) return DIVISIONS * 4;
  return Math.max(beat, Math.round(numerator * beat));
}

/** Index of the measure containing an absolute position, by binary search. */
export function measureIndexAt(measures: MeasureSpec[], units: number): number {
  let lo = 0;
  let hi = measures.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measures[mid].start <= units) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Cut chords at barlines, marking the joins so they can be re-tied. */
export function splitAcrossMeasures(
  chords: { start: number; length: number; midis: number[] }[],
  measures: MeasureSpec[],
): Segment[][] {
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
    if (segment.start < cursor) continue; // covered by an earlier segment
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
  const groupUnits = measure.denominator === 8 && measure.numerator % 3 === 0 ? 36 : DIVISIONS;

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

/** Which letters the key signature alters, indexed C..B. */
export function keyAlterations(fifths: number): number[] {
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
export function spell(midi: number, fifths: number): { step: string; alter: number; octave: number } {
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

/** MIDI pitch for a diatonic staff position plus an alteration. */
export function midiForDiatonic(diatonic: number, alter: number): number {
  const octave = Math.floor(diatonic / 7);
  const letter = ((diatonic % 7) + 7) % 7;
  return (octave + 1) * 12 + LETTER_SEMITONE[letter] + alter;
}

export function writeMusicXml(score: WriterScore): string {
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
  lines.push('      <software>Sheet Reader</software>');
  lines.push('    </encoding>');
  lines.push('  </identification>');
  lines.push('  <part-list>');
  lines.push('    <score-part id="P1">');
  lines.push('      <part-name>Piano</part-name>');
  lines.push('    </score-part>');
  lines.push('  </part-list>');
  lines.push('  <part id="P1">');

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
      const elements = layOutMeasure(perStaff[staff - 1]?.[index] ?? [], measure);
      // Only the first staff carries the tempo marks; a second copy would be
      // read as a second tempo change at the same spot.
      const pending = staff === 1 ? [...(tempos[index] ?? [])] : [];
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
      if (!element.tieStop) {
        lines.push(`        <accidental>${ACCIDENTAL_NAMES[alter] ?? 'natural'}</accidental>`);
      }
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

export const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
