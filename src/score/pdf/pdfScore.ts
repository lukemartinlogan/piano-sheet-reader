/**
 * Reading an engraving.
 *
 * A PDF of sheet music is not a picture of music, it is the music's *drawing* —
 * so unlike a MIDI file, nothing here has to be guessed about pitch. A notehead
 * sits an exact number of half staff spaces from its clef, and that is the
 * note. Measured across a real 7-page score, 99.9% of noteheads land exactly on
 * a step, which is the property this whole module is built on.
 *
 * Rhythm is the hard half. Note *values* are recoverable (the notehead's own
 * shape, its dots, its flags, and the beams crossing its stem), but *onsets*
 * are not drawn at all — they follow from durations accumulating across a bar.
 * So every bar is laid out and then checked against its own time signature, and
 * the bars that do not add up are reported rather than quietly passed off as
 * correct. `stats.exactMeasures` is that number.
 */
import type { PdfGlyph, PdfPageContent, PdfShape } from './pdfContent';
import {
  measureUnits,
  midiForDiatonic,
  splitAcrossMeasures,
  writeMusicXml,
  type MeasureSpec,
  type Segment,
  type TempoMark,
} from '../musicXmlWriter';

// ------------------------------------------------------------- symbols ---

type NoteheadKind = 'whole' | 'half' | 'black';

/**
 * Notehead code points.
 *
 * SMuFL puts these at U+E0A2..E0A4 and most engravers use exactly that. Dorico
 * subsets Bravura through its own mapping and lands on U+F4BC..F4BE, so both
 * are listed; anything else falls back to identifying them by behaviour.
 */
const NOTEHEADS: Record<number, NoteheadKind> = {
  0xe0a2: 'whole',
  0xe0a3: 'half',
  0xe0a4: 'black',
  0xf4bc: 'whole',
  0xf4bd: 'half',
  0xf4be: 'black',
};

const ACCIDENTALS: Record<number, number> = {
  0xe260: -1,
  0xe261: 0,
  0xe262: 1,
  0xe263: 2,
  0xe264: -2,
};

/** Reference pitch each clef names, as an absolute diatonic step (C0 = 0). */
const CLEFS: Record<number, { sign: string; diatonic: number }> = {
  0xe050: { sign: 'G', diatonic: 4 * 7 + 4 }, // G4, on the line the curl encircles
  0xe062: { sign: 'F', diatonic: 3 * 7 + 3 }, // F3, between the two dots
  0xe05c: { sign: 'C', diatonic: 4 * 7 + 0 }, // C4, at the centre
};

const AUGMENTATION_DOT = 0xe1e7;
const TIME_SIG_ZERO = 0xe080;

/** Rest values, in DIVISIONS units. */
const RESTS: Record<number, number> = {
  0xe4e2: 192,
  0xe4e3: 96,
  0xe4e4: 48,
  0xe4e5: 24,
  0xe4e6: 12,
  0xe4e7: 6,
  0xe4e8: 3,
};

/** Flags, by how many beam levels they stand for. */
const FLAGS: Record<number, number> = {
  0xe240: 1,
  0xe241: 1,
  0xe242: 2,
  0xe243: 2,
  0xe244: 3,
  0xe245: 3,
  0xe246: 4,
  0xe247: 4,
};

/** Metronome note glyphs, so "= 120" can be read off the page. */
const METRONOME_NOTES = new Set([0xeca3, 0xeca5, 0xeca7, 0xeca9]);

// ------------------------------------------------------------- geometry ---

interface Staff {
  page: number;
  /** y of the top line, measured down the page. */
  topY: number;
  space: number;
  x0: number;
  x1: number;
}

interface SystemStaff extends Staff {
  clefSign: string;
  clefLine: number;
  /** Absolute diatonic step of the clef's reference line. */
  clefDiatonic: number;
  clefY: number;
}

interface System {
  page: number;
  staves: SystemStaff[];
  x0: number;
  x1: number;
  /** Barline x positions, including both ends of the system. */
  boundaries: number[];
  fifths: number;
  /** Every metre printed in this system, with where it starts applying. */
  timeSignatures: { x: number; numerator: number; denominator: number }[];
}

const midY = (shape: PdfShape) => (shape.y0 + shape.y1) / 2;
const shapeWidth = (shape: PdfShape) => shape.x1 - shape.x0;
const shapeHeight = (shape: PdfShape) => shape.y1 - shape.y0;

/**
 * Find five-line staves.
 *
 * Staff lines are the only long hairline horizontals on the page. They are
 * collected, merged where the engraver split one line into segments, then read
 * off in groups of five with matching gaps — which is what tells a staff apart
 * from a stave-like row of ledger lines or a hairpin.
 */
function findStaves(page: PdfPageContent): Staff[] {
  const candidates = page.shapes.filter(
    (shape) => !shape.curved && shapeHeight(shape) < 1.6 && shapeWidth(shape) > 60,
  );
  if (candidates.length < 5) return [];

  const rows: { y: number; x0: number; x1: number }[] = [];
  for (const shape of [...candidates].sort((a, b) => midY(a) - midY(b))) {
    const y = midY(shape);
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - y) < 0.7) {
      last.x0 = Math.min(last.x0, shape.x0);
      last.x1 = Math.max(last.x1, shape.x1);
    } else {
      rows.push({ y, x0: shape.x0, x1: shape.x1 });
    }
  }

  const staves: Staff[] = [];
  let index = 0;
  while (index + 4 < rows.length) {
    const five = rows.slice(index, index + 5);
    const gaps = [1, 2, 3, 4].map((k) => five[k].y - five[k - 1].y);
    const space = gaps.reduce((sum, gap) => sum + gap, 0) / 4;
    const even = space > 1.5 && gaps.every((gap) => Math.abs(gap - space) < space * 0.3);
    if (even) {
      staves.push({
        page: page.page,
        topY: five[0].y,
        space,
        x0: Math.min(...five.map((row) => row.x0)),
        x1: Math.max(...five.map((row) => row.x1)),
      });
      index += 5;
    } else {
      index += 1;
    }
  }
  return staves;
}

/** Group staves into systems: same page, same width, close enough to be braced. */
function groupSystems(staves: Staff[]): Staff[][] {
  const systems: Staff[][] = [];
  for (const staff of staves) {
    const current = systems[systems.length - 1];
    const previous = current?.[current.length - 1];
    const overlap =
      previous &&
      previous.page === staff.page &&
      Math.min(previous.x1, staff.x1) - Math.max(previous.x0, staff.x0) >
        (previous.x1 - previous.x0) * 0.6;
    const gap = previous ? staff.topY - (previous.topY + previous.space * 4) : Infinity;
    if (current && overlap && gap > 0 && gap < staff.space * 11) current.push(staff);
    else systems.push([staff]);
  }
  return systems;
}

/**
 * Nearest staff to a y position, or null if nothing is near enough.
 *
 * The limit is what keeps one system's notes out of another's. A page holds
 * several systems and they all occupy the same horizontal span, so "nearest
 * staff" with no cutoff quietly assigns every system's notes to whichever
 * system is being read — every bar then holds five bars' worth of notes.
 *
 * Eight staff spaces is comfortably past the deepest ledger line a note is
 * printed on, and comfortably short of the next system.
 */
function nearestStaff<T extends Staff>(staves: T[], y: number, limitSpaces = 8): T | null {
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const staff of staves) {
    const top = staff.topY;
    const bottom = staff.topY + staff.space * 4;
    const distance = y < top ? top - y : y > bottom ? y - bottom : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = staff;
    }
  }
  if (!best || bestDistance > best.space * limitSpaces) return null;
  return best;
}

// -------------------------------------------------------------- reading ---

interface NoteEvent {
  kind: 'note' | 'rest';
  x: number;
  /** DIVISIONS units. */
  duration: number;
  /** Absolute diatonic steps, one per notehead in the chord. */
  diatonics: number[];
  alters: (number | null)[];
  /** true when the stem points up, null when there is no stem. */
  stemUp: boolean | null;
}

export interface PdfImportStats {
  pages: number;
  systems: number;
  staves: number;
  measures: number;
  notes: number;
  /** Bars whose note values add up to their own time signature. */
  exactMeasures: number;
  /** Bars laid out by falling back to horizontal position. */
  fallbackMeasures: number;
  noteheadCode: string;
  detectedTempo: number | null;
  /** Per-bar arithmetic, for diagnosing why a bar did not add up. */
  bars: BarDiagnostic[];
}

export interface BarDiagnostic {
  bar: number;
  staff: number;
  /** Sum of the note values found, in DIVISIONS units. */
  sum: number;
  expected: number;
  events: number;
  /** How many of the events carried a beam or flag. */
  beamed: number;
}

export interface PdfScoreResult {
  xml: string;
  stats: PdfImportStats;
}

/** Build a score out of everything the pages drew. */
export function buildScoreFromPdf(
  input: PdfPageContent[],
  filename: string,
  title?: string,
): PdfScoreResult {
  const pages = input;
  const allStaves: Staff[] = [];
  for (const page of pages) allStaves.push(...findStaves(page));
  if (allStaves.length === 0) {
    throw new Error(
      `${filename} has no staves this reader can find. Scanned or image-only PDFs are not supported — only PDFs exported from notation software.`,
    );
  }

  const noteheadCodes = resolveNoteheadCodes(pages, allStaves);
  const grouped = groupSystems(allStaves);
  const systems: System[] = [];

  for (const staffGroup of grouped) {
    const page = pages.find((candidate) => candidate.page === staffGroup[0].page)!;
    systems.push(readSystem(page, staffGroup));
  }

  const staffCount = Math.max(...systems.map((system) => system.staves.length));

  // Metre and key carry forward until something on the page changes them.
  const measures: MeasureSpec[] = [];
  const chordsPerStaff: { start: number; length: number; midis: number[] }[][] = Array.from(
    { length: staffCount },
    () => [],
  );

  let numerator = systems[0]?.timeSignatures[0]?.numerator ?? 4;
  let denominator = systems[0]?.timeSignatures[0]?.denominator ?? 4;
  let fifths = systems[0]?.fifths ?? 0;
  let position = 0;
  let exact = 0;
  let fallback = 0;
  let noteCount = 0;
  const bars: BarDiagnostic[] = [];

  for (const system of systems) {
    let showKey = measures.length === 0;
    if (system.fifths !== fifths) {
      fifths = system.fifths;
      showKey = true;
    }

    for (let b = 0; b + 1 < system.boundaries.length; b++) {
      const xStart = system.boundaries[b];
      const xEnd = system.boundaries[b + 1];

      // A metre printed at the head of this bar takes effect from here.
      const space = system.staves[0].space;
      let showTime = measures.length === 0;
      for (const signature of system.timeSignatures) {
        if (signature.x < xStart - space || signature.x > xStart + space * 14) continue;
        if (signature.numerator !== numerator || signature.denominator !== denominator) {
          numerator = signature.numerator;
          denominator = signature.denominator;
          showTime = true;
        }
      }
      const length = measureUnits(numerator, denominator);

      measures.push({
        start: position,
        length,
        numerator,
        denominator,
        fifths,
        showTime,
        showKey: showKey && b === 0,
      });

      let measureExact = true;
      let measureFallback = false;
      const perStaffEvents = readMeasureEvents(
        pages.find((page) => page.page === system.page)!,
        system,
        xStart,
        xEnd,
        noteheadCodes,
        fifths,
      );
      for (let s = 0; s < staffCount; s++) {
        const staff = system.staves[s];
        if (!staff) continue;
        const events = perStaffEvents[s] ?? [];
        if (bars.length < 400) {
          bars.push({
            bar: measures.length,
            staff: s + 1,
            sum: events.reduce((total, event) => total + event.duration, 0),
            expected: length,
            events: events.length,
            beamed: events.filter((event) => event.kind === 'note' && event.duration < 24).length,
          });
        }

        const laid = layOutBar(events, length);
        if (!laid.exact) measureExact = false;
        if (laid.fallback) measureFallback = true;

        for (const placed of laid.chords) {
          if (placed.midis.length === 0) continue;
          noteCount += placed.midis.length;
          chordsPerStaff[s].push({
            start: position + placed.start,
            length: placed.length,
            midis: placed.midis,
          });
        }
      }
      if (measureExact) exact++;
      if (measureFallback) fallback++;

      position += length;
      showTime = false;
      showKey = false;
    }
  }

  if (measures.length === 0) {
    throw new Error(`${filename} has staves but no barlines, so it cannot be divided into measures.`);
  }

  const perStaff: Segment[][][] = chordsPerStaff.map((chords) =>
    splitAcrossMeasures(
      [...chords].sort((a, b) => a.start - b.start),
      measures,
    ),
  );

  const clefs = systems[0].staves.map((staff) => ({ sign: staff.clefSign, line: staff.clefLine }));
  while (clefs.length < staffCount) clefs.push({ sign: 'G', line: 2 });

  const tempo = readTempo(pages[0]);
  const tempos: TempoMark[][] = measures.map(() => []);
  tempos[0] = [{ units: 0, bpm: tempo ?? 100, visible: tempo !== null }];

  return {
    xml: writeMusicXml({
      measures,
      perStaff,
      staffCount,
      clefs,
      tempos,
      title: title || stripExtension(filename),
      copyright: '',
    }),
    stats: {
      pages: pages.length,
      systems: systems.length,
      staves: allStaves.length,
      measures: measures.length,
      notes: noteCount,
      exactMeasures: exact,
      fallbackMeasures: fallback,
      noteheadCode: [...noteheadCodes.keys()]
        .map((code) => `U+${code.toString(16).toUpperCase()}`)
        .join(','),
      detectedTempo: tempo,
      bars,
    },
  };
}

/**
 * Which glyphs are noteheads.
 *
 * The standard code points are tried first. If a producer uses its own mapping
 * that we do not know, they are identified by behaviour instead: a notehead is
 * the glyph that turns up most often *and* lands on staff steps, which nothing
 * else on a page does.
 */
function resolveNoteheadCodes(
  pages: PdfPageContent[],
  staves: Staff[],
): Map<number, NoteheadKind> {
  const known = new Map<number, NoteheadKind>();
  const counts = new Map<number, number>();
  for (const page of pages) {
    for (const glyph of page.glyphs) {
      counts.set(glyph.code, (counts.get(glyph.code) ?? 0) + 1);
      const kind = NOTEHEADS[glyph.code];
      if (kind) known.set(glyph.code, kind);
    }
  }
  if (known.size > 0) return known;

  // Fall back to the most frequent glyph that sits on staff steps.
  let best = 0;
  let bestScore = 0;
  for (const [code, count] of counts) {
    if (code < 0xe000 || count < 20) continue;
    let onStep = 0;
    let total = 0;
    for (const page of pages) {
      const pageStaves = staves.filter((staff) => staff.page === page.page);
      for (const glyph of page.glyphs) {
        if (glyph.code !== code) continue;
        const staff = nearestStaff(pageStaves, glyph.y);
        if (!staff) continue;
        total++;
        const steps = (staff.topY + staff.space * 4 - glyph.y) / (staff.space / 2);
        if (Math.abs(steps - Math.round(steps)) < 0.15) onStep++;
      }
    }
    const score = total > 0 && onStep / total > 0.9 ? count : 0;
    if (score > bestScore) {
      bestScore = score;
      best = code;
    }
  }
  if (best === 0) {
    throw new Error(
      'No noteheads recognised in this PDF. It may be a scan, or use a music font this reader does not know.',
    );
  }
  return new Map([[best, 'black' as NoteheadKind]]);
}

/** Read a system's clefs, key, metre and barlines. */
function readSystem(page: PdfPageContent, staves: Staff[]): System {
  const x0 = Math.min(...staves.map((staff) => staff.x0));
  const x1 = Math.max(...staves.map((staff) => staff.x1));
  const space = staves[0].space;
  const top = staves[0].topY;
  const bottom = staves[staves.length - 1].topY + space * 4;

  const withClefs: SystemStaff[] = staves.map((staff) => {
    const clefGlyphs = page.glyphs
      .filter((glyph) => CLEFS[glyph.code] && nearestStaff(staves, glyph.y) === staff)
      .sort((a, b) => a.x - b.x);
    const first = clefGlyphs[0];
    if (!first) {
      return { ...staff, clefSign: 'G', clefLine: 2, clefDiatonic: 4 * 7 + 4, clefY: staff.topY + staff.space * 3 };
    }
    const clef = CLEFS[first.code];
    const line = Math.round((staff.topY + staff.space * 4 - first.y) / staff.space) + 1;
    return {
      ...staff,
      clefSign: clef.sign,
      clefLine: Math.max(1, Math.min(5, line)),
      clefDiatonic: clef.diatonic,
      clefY: first.y,
    };
  });

  // A barline runs the full height of the system, top staff's top line to
  // bottom staff's bottom line. Stems are the same order of length and a stem
  // can happen to reach from one staff line to another, so accepting anything
  // shorter invents barlines and chops bars into pieces.
  const boundaries: number[] = [];
  for (const shape of page.shapes) {
    if (shape.curved || shapeWidth(shape) > 2.6 || shapeHeight(shape) < space * 3) continue;
    const spansSystem =
      Math.abs(shape.y0 - top) < space * 0.8 && Math.abs(shape.y1 - bottom) < space * 0.8;
    if (spansSystem) boundaries.push((shape.x0 + shape.x1) / 2);
  }
  boundaries.push(x0, x1);
  boundaries.sort((a, b) => a - b);

  const deduped: number[] = [];
  for (const x of boundaries) {
    if (deduped.length === 0 || x - deduped[deduped.length - 1] > space * 1.2) deduped.push(x);
  }

  const first = withClefs[0];
  const timeSignatures = readTimeSignatures(page, first);
  const fifths = readKeySignature(page, first, timeSignatures[0]?.x ?? null);

  return {
    page: page.page,
    staves: withClefs,
    x0,
    x1,
    boundaries: deduped,
    fifths,
    timeSignatures,
  };
}

/**
 * Read every time signature printed on a staff, with the x it takes effect at.
 *
 * A metre change is drawn at the bar it applies to, which is very often in the
 * middle of a system — reading only the one at the start of a system means
 * every bar after a change is measured against the wrong length, and none of
 * them can ever add up.
 */
function readTimeSignatures(
  page: PdfPageContent,
  staff: SystemStaff,
): { x: number; numerator: number; denominator: number }[] {
  const middle = staff.topY + staff.space * 2;
  const digits = page.glyphs
    .filter(
      (glyph) =>
        glyph.code >= TIME_SIG_ZERO &&
        glyph.code <= TIME_SIG_ZERO + 9 &&
        Math.abs(glyph.y - middle) < staff.space * 4,
    )
    .sort((a, b) => a.x - b.x);
  if (digits.length < 2) return [];

  // Digits of one signature sit within a couple of staff spaces of each other.
  const clusters: PdfGlyph[][] = [];
  for (const glyph of digits) {
    const last = clusters[clusters.length - 1];
    if (last && glyph.x - Math.max(...last.map((g) => g.x)) < staff.space * 2.5) last.push(glyph);
    else clusters.push([glyph]);
  }

  const read = (list: PdfGlyph[]) =>
    Number(
      [...list]
        .sort((a, b) => a.x - b.x)
        .map((glyph) => String(glyph.code - TIME_SIG_ZERO))
        .join(''),
    );

  const found: { x: number; numerator: number; denominator: number }[] = [];
  for (const cluster of clusters) {
    const upper = cluster.filter((glyph) => glyph.y < middle);
    const lower = cluster.filter((glyph) => glyph.y >= middle);
    if (upper.length === 0 || lower.length === 0) continue;
    const numerator = read(upper);
    const denominator = read(lower);
    if (!numerator || !denominator) continue;
    found.push({ x: Math.min(...cluster.map((glyph) => glyph.x)), numerator, denominator });
  }
  return found;
}

/** Accidentals between the clef and the metre are the key signature. */
function readKeySignature(page: PdfPageContent, staff: SystemStaff, timeX: number | null): number {
  const limit = timeX ?? staff.x0 + (staff.x1 - staff.x0) * 0.2;
  const accidentals = page.glyphs.filter(
    (glyph) =>
      ACCIDENTALS[glyph.code] !== undefined &&
      glyph.x > staff.clefY * 0 + staff.x0 &&
      glyph.x < limit &&
      Math.abs(glyph.y - (staff.topY + staff.space * 2)) < staff.space * 5,
  );
  if (accidentals.length === 0) return 0;
  const sharps = accidentals.filter((glyph) => ACCIDENTALS[glyph.code] === 1).length;
  const flats = accidentals.filter((glyph) => ACCIDENTALS[glyph.code] === -1).length;
  if (sharps > flats) return Math.min(7, sharps);
  if (flats > sharps) return -Math.min(7, flats);
  return 0;
}

/** A metronome mark: a note glyph, then "= 120" in the text font beside it. */
function readTempo(page: PdfPageContent | undefined): number | null {
  if (!page) return null;
  const mark = page.glyphs.find((glyph) => METRONOME_NOTES.has(glyph.code));
  if (!mark) return null;
  const digits = page.glyphs
    .filter(
      (glyph) =>
        glyph.code >= 0x30 &&
        glyph.code <= 0x39 &&
        Math.abs(glyph.y - mark.y) < mark.size * 0.8 &&
        glyph.x > mark.x &&
        glyph.x < mark.x + mark.size * 4,
    )
    .sort((a, b) => a.x - b.x);
  if (digits.length === 0) return null;
  const value = Number(digits.map((glyph) => String.fromCodePoint(glyph.code)).join(''));
  return value >= 20 && value <= 400 ? value : null;
}

/**
 * Everything sounding between two barlines, split across the system's staves.
 *
 * The whole bar is read at once rather than staff by staff, because which staff
 * a notehead belongs to is not decided by the notehead alone. A treble note
 * printed below its staff sits nearer the bass staff, and assigning it by
 * proximity hands the left hand notes the right hand is playing. Its *stem*
 * settles it: the stem runs back toward the staff the note was written for, so
 * a chord is assigned by where its stem ends up, and only stemless notes fall
 * back to proximity.
 */
function readMeasureEvents(
  page: PdfPageContent,
  system: System,
  xStart: number,
  xEnd: number,
  noteheadCodes: Map<number, NoteheadKind>,
  fifths: number,
): NoteEvent[][] {
  const space = system.staves[0].space;
  const inBar = (x: number) => x >= xStart - space * 0.3 && x < xEnd - space * 0.2;
  const inSystem = (glyph: PdfGlyph) => nearestStaff(system.staves, glyph.y) !== null;

  const pick = (test: (glyph: PdfGlyph) => boolean) =>
    page.glyphs.filter((glyph) => test(glyph) && inBar(glyph.x) && inSystem(glyph));

  const heads = pick((glyph) => noteheadCodes.has(glyph.code));
  const accidentalGlyphs = pick((glyph) => ACCIDENTALS[glyph.code] !== undefined);
  const dots = pick((glyph) => glyph.code === AUGMENTATION_DOT);
  const flags = pick((glyph) => FLAGS[glyph.code] !== undefined);

  const stems = page.shapes.filter(
    (shape) =>
      !shape.curved &&
      shapeWidth(shape) < 2.6 &&
      shapeHeight(shape) > space * 1.2 &&
      shapeHeight(shape) < space * 12 &&
      shape.x0 >= xStart - space &&
      shape.x1 < xEnd &&
      nearestStaff(system.staves, midY(shape)) !== null,
  );
  const beams = page.shapes.filter(
    (shape) =>
      !shape.curved &&
      shape.points.length >= 4 &&
      shapeWidth(shape) > space * 0.6 &&
      shapeHeight(shape) < space * 2.2 &&
      shapeHeight(shape) > space * 0.15 &&
      shape.x1 > xStart &&
      shape.x0 < xEnd &&
      nearestStaff(system.staves, midY(shape)) !== null,
  );

  // Group noteheads sharing a stem into chords; otherwise by proximity.
  interface Group {
    x: number;
    heads: PdfGlyph[];
    stem: PdfShape | null;
  }
  const groups: Group[] = [];
  for (const head of [...heads].sort((a, b) => a.x - b.x)) {
    const stem =
      stems.find(
        (shape) =>
          Math.abs(shape.x0 - head.x) < space * 1.6 &&
          head.y > shape.y0 - space * 0.7 &&
          head.y < shape.y1 + space * 0.7,
      ) ?? null;
    const existing = groups.find((group) =>
      stem ? group.stem === stem : !group.stem && Math.abs(group.x - head.x) < space * 0.7,
    );
    if (existing) {
      existing.heads.push(head);
      existing.x = Math.min(existing.x, head.x);
    } else {
      groups.push({ x: head.x, heads: [head], stem });
    }
  }

  const perStaff: NoteEvent[][] = system.staves.map(() => []);
  const staffIndex = (staff: SystemStaff | null) =>
    staff ? Math.max(0, system.staves.indexOf(staff)) : 0;

  for (const group of groups) {
    const kinds = group.heads.map((head) => noteheadCodes.get(head.code) ?? 'black');
    const kind: NoteheadKind = kinds.includes('black')
      ? 'black'
      : kinds.includes('half')
        ? 'half'
        : 'whole';

    // Follow the stem home. Its far end is inside the staff the note was
    // written on, even when the notehead itself sits out on ledger lines.
    const headY = group.heads.reduce((sum, head) => sum + head.y, 0) / group.heads.length;
    let owner = nearestStaff(system.staves, headY);
    if (group.stem) {
      const far = Math.abs(group.stem.y0 - headY) > Math.abs(group.stem.y1 - headY)
        ? group.stem.y0
        : group.stem.y1;
      owner = nearestStaff(system.staves, far) ?? owner;
    }
    if (!owner) continue;
    const staff = owner;

    let duration = kind === 'whole' ? 96 : kind === 'half' ? 48 : 24;
    if (kind === 'black' && group.stem) {
      const levels = Math.max(
        beamsCrossing(beams, group.stem, space),
        flagLevels(flags, group.stem, space),
      );
      if (levels > 0) duration = Math.max(3, 24 >> levels);
    }

    // Dots sit to the right of the head, on its own line or the space above.
    const rightmost = Math.max(...group.heads.map((head) => head.x));
    const dotCount = Math.min(
      2,
      dots.filter(
        (dot) =>
          dot.x > rightmost &&
          dot.x < rightmost + space * 3.2 &&
          group.heads.some((head) => Math.abs(dot.y - head.y) < space * 0.75),
      ).length,
    );
    for (let d = 0; d < dotCount; d++) duration = Math.round(duration * (d === 0 ? 1.5 : 7 / 6));

    const diatonics = group.heads.map((head) => staffDiatonic(head, staff));
    const alters = group.heads.map((head) => {
      const accidental = accidentalGlyphs.find(
        (glyph) =>
          glyph.x < head.x &&
          glyph.x > head.x - space * 4 &&
          Math.abs(glyph.y - head.y) < space * 0.4,
      );
      return accidental ? ACCIDENTALS[accidental.code] : null;
    });

    perStaff[staffIndex(staff)].push({
      kind: 'note',
      x: group.x,
      duration,
      diatonics,
      alters,
      stemUp: group.stem ? midY(group.stem) < Math.min(...group.heads.map((h) => h.y)) : null,
    });
  }

  for (const glyph of page.glyphs) {
    const value = RESTS[glyph.code];
    if (value === undefined || !inBar(glyph.x)) continue;
    const staff = nearestStaff(system.staves, glyph.y);
    if (!staff) continue;
    const dotCount = dots.filter(
      (dot) => dot.x > glyph.x && dot.x < glyph.x + space * 3 && Math.abs(dot.y - glyph.y) < space,
    ).length;
    perStaff[staffIndex(staff)].push({
      kind: 'rest',
      x: glyph.x,
      duration: dotCount > 0 ? Math.round(value * 1.5) : value,
      diatonics: [],
      alters: [],
      stemUp: null,
    });
  }

  for (const events of perStaff) {
    applyAccidentals(events, fifths);
    events.sort((a, b) => a.x - b.x);
  }
  return perStaff;
}

/** Absolute diatonic step of a notehead, read against its clef. */
function staffDiatonic(head: PdfGlyph, staff: SystemStaff): number {
  const steps = (staff.clefY - head.y) / (staff.space / 2);
  return staff.clefDiatonic + Math.round(steps);
}

/**
 * Turn printed accidentals into pitch alterations.
 *
 * An accidental holds for the rest of the bar on the line it was written, which
 * is why this runs over a whole measure at once rather than note by note.
 */
function applyAccidentals(events: NoteEvent[], fifths: number): void {
  const KEY_ORDER_SHARP = [3, 0, 4, 1, 5, 2, 6];
  const KEY_ORDER_FLAT = [6, 2, 5, 1, 4, 0, 3];
  const keyAlter = new Array<number>(7).fill(0);
  const order = fifths >= 0 ? KEY_ORDER_SHARP : KEY_ORDER_FLAT;
  for (let i = 0; i < Math.min(7, Math.abs(fifths)); i++) keyAlter[order[i]] = fifths >= 0 ? 1 : -1;

  const inForce = new Map<number, number>();
  for (const event of [...events].sort((a, b) => a.x - b.x)) {
    event.diatonics.forEach((diatonic, index) => {
      const printed = event.alters[index];
      if (printed !== null && printed !== undefined) {
        inForce.set(diatonic, printed);
        return;
      }
      const held = inForce.get(diatonic);
      event.alters[index] = held ?? keyAlter[((diatonic % 7) + 7) % 7];
    });
  }
}

/** How many beams cross a stem, which is what turns a quarter into a 16th. */
function beamsCrossing(beams: PdfShape[], stem: PdfShape, space: number): number {
  const x = (stem.x0 + stem.x1) / 2;
  let count = 0;
  for (const beam of beams) {
    if (x < beam.x0 - 0.5 || x > beam.x1 + 0.5) continue;
    const y = interpolateTop(beam, x);
    if (y === null) continue;
    // The beam has to sit along the stem, not merely overlap its column.
    if (y >= stem.y0 - space * 0.6 && y <= stem.y1 + space * 0.6) count++;
  }
  return count;
}

/** Top edge of a (possibly slanted) beam at a given x. */
function interpolateTop(beam: PdfShape, x: number): number | null {
  let left: { x: number; y: number } | null = null;
  let right: { x: number; y: number } | null = null;
  for (const point of beam.points) {
    if (!left || point.x < left.x || (point.x === left.x && point.y < left.y)) left = point;
    if (!right || point.x > right.x || (point.x === right.x && point.y < right.y)) right = point;
  }
  if (!left || !right || right.x - left.x < 0.01) return null;
  const t = (x - left.x) / (right.x - left.x);
  return left.y + (right.y - left.y) * Math.min(1, Math.max(0, t));
}

function flagLevels(flags: PdfGlyph[], stem: PdfShape, space: number): number {
  let best = 0;
  for (const flag of flags) {
    if (Math.abs(flag.x - stem.x0) > space * 1.6) continue;
    if (flag.y < stem.y0 - space || flag.y > stem.y1 + space) continue;
    best = Math.max(best, FLAGS[flag.code] ?? 0);
  }
  return best;
}

// -------------------------------------------------------------- rhythm ---

interface PlacedChord {
  start: number;
  length: number;
  midis: number[];
}

/**
 * Give every event in a bar an onset.
 *
 * Onsets are not drawn: they follow from durations accumulating from the
 * barline. So the note values are trusted first and checked against the bar's
 * own length — a bar that adds up is almost certainly right. When it does not,
 * the usual cause is two voices sharing the staff, so they are separated by
 * stem direction and accumulated independently. Failing that, the bar is placed
 * by horizontal position, which is never exact but never nonsense either.
 */
function layOutBar(
  events: NoteEvent[],
  length: number,
): { chords: PlacedChord[]; exact: boolean; fallback: boolean } {
  if (events.length === 0) return { chords: [], exact: true, fallback: false };

  const total = events.reduce((sum, event) => sum + event.duration, 0);
  if (total === length) {
    return { chords: accumulate(events), exact: true, fallback: false };
  }

  // Two voices on one staff, each filling the bar on its own. Requiring both
  // to add up exactly is too strict — one voice is often written with rests
  // this reader does not pick up — so one voice adding up is taken as evidence
  // the split is real, and the other is accumulated alongside it.
  const up = events.filter((event) => event.stemUp === true);
  const down = events.filter((event) => event.stemUp === false);
  if (up.length > 0 && down.length > 0) {
    const upTotal = up.reduce((sum, event) => sum + event.duration, 0);
    const downTotal = down.reduce((sum, event) => sum + event.duration, 0);
    if (upTotal === length || downTotal === length) {
      const chords = merge(accumulate(up), accumulate(down)).filter((chord) => chord.start < length);
      for (const chord of chords) chord.length = Math.min(chord.length, length - chord.start);
      return { chords, exact: upTotal === length && downTotal === length, fallback: false };
    }
  }

  // Nothing added up. Trust the engraver's spacing instead of the note values.
  if (total > length * 1.02 || total < length * 0.98) {
    return { chords: byPosition(events, length), exact: false, fallback: true };
  }
  return { chords: accumulate(events), exact: false, fallback: false };
}

function accumulate(events: NoteEvent[]): PlacedChord[] {
  const chords: PlacedChord[] = [];
  let position = 0;
  for (const event of events) {
    if (event.kind === 'note') {
      chords.push({ start: position, length: event.duration, midis: pitchesOf(event) });
    }
    position += event.duration;
  }
  return chords;
}

/** Lay a bar out from where the engraver put things, when the values do not fit. */
function byPosition(events: NoteEvent[], length: number): PlacedChord[] {
  const xs = events.map((event) => event.x);
  const first = Math.min(...xs);
  const last = Math.max(...xs);
  const span = Math.max(1, last - first);
  const grid = 6; // sixteenths: fine enough to place, coarse enough to print

  const chords: PlacedChord[] = [];
  events.forEach((event, index) => {
    const fraction = (event.x - first) / span;
    // The last onset must still leave room for itself inside the bar.
    let start = Math.round((fraction * (length - grid)) / grid) * grid;
    start = Math.max(0, Math.min(length - grid, start));
    if (index > 0 && chords.length > 0) {
      const previous = chords[chords.length - 1];
      if (start <= previous.start) start = Math.min(length - grid, previous.start + grid);
    }
    if (event.kind === 'note') {
      chords.push({ start, length: Math.min(event.duration, length - start), midis: pitchesOf(event) });
    }
  });

  for (let i = 0; i < chords.length - 1; i++) {
    chords[i].length = Math.max(grid, Math.min(chords[i].length, chords[i + 1].start - chords[i].start));
  }
  return chords;
}

/** Fold two voices into one line, joining anything that starts together. */
function merge(a: PlacedChord[], b: PlacedChord[]): PlacedChord[] {
  const byStart = new Map<number, PlacedChord>();
  for (const chord of [...a, ...b]) {
    const existing = byStart.get(chord.start);
    if (existing) {
      existing.midis = [...new Set([...existing.midis, ...chord.midis])].sort((x, y) => x - y);
      existing.length = Math.max(existing.length, chord.length);
    } else {
      byStart.set(chord.start, { ...chord, midis: [...chord.midis] });
    }
  }
  return [...byStart.values()].sort((x, y) => x.start - y.start);
}

function pitchesOf(event: NoteEvent): number[] {
  const midis = event.diatonics.map((diatonic, index) =>
    midiForDiatonic(diatonic, event.alters[index] ?? 0),
  );
  // Anything off the keyboard is a misread rather than a note, so drop it
  // instead of writing a pitch no piano can play.
  return [...new Set(midis)].filter((midi) => midi >= 21 && midi <= 108).sort((a, b) => a - b);
}

const stripExtension = (filename: string): string =>
  filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
