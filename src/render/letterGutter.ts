import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import type { Clef, ParsedScore } from '../score/types';
import { clefAt, extentAt } from '../score/types';
import { collectGeometry, type PageGeometry, type StaffGeometry } from './geometry';
import { bottomLineDiatonic, letterForDiatonic, octaveForDiatonic } from './staffPositions';
import { colorFor } from './palette';

const SVG_NS = 'http://www.w3.org/2000/svg';
const GUTTER_ATTR = 'data-letter-gutter';

/** Never extend further past the staff than this, whatever the notes do. */
const MAX_POSITIONS_BEYOND = 22;

/**
 * Letter height, in staff spaces. Constant everywhere: a guide that changes size
 * from measure to measure is harder to read than one that is uniformly smaller.
 *
 * The ceiling is set by OSMD, not by taste. The first note of a measure always
 * sits ~2.1 staff spaces from the barline no matter what MeasureLeftMargin is
 * set to (measured: 0.7 -> 24 units moved it not at all; it only inflates the
 * system count), leaving ~1.4 spaces of clear room. Two sub-columns at this size
 * need ~1.35, which fits in all but a handful of unusually tight measures.
 */
const LETTER_SIZE_UNITS = 0.9;

/** Horizontal ink width as a multiple of the font size, measured from rendered glyphs. */
const INK_FACTOR_PLAIN = 1.5;
const INK_FACTOR_OCTAVES = 2.9;

export type GutterMode = 'measure' | 'system' | 'off';

export interface GutterOptions {
  mode: GutterMode;
  showOctaves: boolean;
  /** Extra labelled positions above and below the staff, beyond what the notes need. */
  ledgerPositions: number;
  /** Colour letters (and noteheads) by pitch letter. */
  colorByLetter: boolean;
  /** Tint the full-width row band behind the staff. */
  showBands: boolean;
  /** Print each note's letter inside its own notehead. */
  lettersInNotes: boolean;
}

export const DEFAULT_GUTTER: GutterOptions = {
  // Letters live in the noteheads now; the margin columns and their staff-line
  // extensions are opt-in from Settings.
  mode: 'off',
  showOctaves: false,
  ledgerPositions: 0,
  colorByLetter: true,
  showBands: false,
  lettersInNotes: true,
};

/**
 * Width of the ink we actually draw, in OSMD units.
 *
 * Two sub-columns of one character each need far less room than it looks, and
 * keeping this tight is what stops the letters colliding with the music when
 * OSMD compresses a measure.
 */
export function gutterInkUnits(options: GutterOptions): number {
  if (options.mode === 'off') return 0;
  return options.showOctaves ? 5.7 : 3.3;
}

/**
 * Space to ask OSMD to reserve at the start of each measure.
 *
 * Deliberately more generous than the ink: OSMD treats the measure margin as a
 * hint and compresses it while justifying a system to full width, so asking for
 * roughly double reliably leaves enough room for the ink.
 */
export function gutterReserveUnits(options: GutterOptions): number {
  if (options.mode === 'off') return 0;
  return gutterInkUnits(options) * 2 + 1.5;
}

/**
 * A staff position: 0 is the bottom line, 1 the space above it, and so on, so
 * even indices are lines and odd indices are spaces. Negative indices run below
 * the staff into the ledger area.
 */
interface Position {
  index: number;
  isLine: boolean;
  letter: string;
  octave: number;
}

function positionsFor(clef: Clef, lowIndex: number, highIndex: number): Position[] {
  const bottom = bottomLineDiatonic(clef);
  const out: Position[] = [];
  for (let i = lowIndex; i <= highIndex; i++) {
    const diatonic = bottom + i;
    out.push({
      index: i,
      isLine: ((i % 2) + 2) % 2 === 0,
      letter: letterForDiatonic(diatonic),
      octave: octaveForDiatonic(diatonic),
    });
  }
  return out;
}

/** Remove any gutter drawn by a previous pass. */
export function clearLetterGutter(osmd: OpenSheetMusicDisplay): void {
  const container: HTMLElement | undefined = (osmd as any).container;
  container?.querySelectorAll(`[${GUTTER_ATTR}]`).forEach((el) => el.remove());
}

/**
 * Draw the reading aid: a column of letter names beside the staff, so a note's
 * name can be read straight across instead of counted up from the clef.
 *
 * Every position is labelled, lines and spaces alike, so the column reads as a
 * continuous alphabet (E F G A B C D E F on a treble staff). Lines and spaces
 * are staggered into two sub-columns because nine labels across a four-space
 * staff would otherwise collide.
 *
 * The column extends below the staff far enough to name the lowest note printed
 * in that measure, so ledger-line notes are covered too.
 */
export function drawLetterGutter(
  osmd: OpenSheetMusicDisplay,
  score: ParsedScore,
  options: GutterOptions,
): void {
  clearLetterGutter(osmd);
  if (options.mode === 'off') return;

  for (const page of collectGeometry(osmd)) {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute(GUTTER_ATTR, 'true');
    group.setAttribute('class', 'letter-gutter');
    // Behind the notes, so it can never obscure them.
    page.svg.insertBefore(group, page.svg.firstChild);

    for (const staff of page.staves) {
      const room = headroom(page, staff);
      for (const anchor of anchorsFor(score, staff, page.scale, options)) {
        drawColumn(group, page.scale, staff, anchor, room, options);
      }
    }
  }
}

/**
 * How many half-space steps the guide may run past a staff, above and below,
 * before it would collide with a neighbouring staff. Ledger-line notes already
 * live in these gaps, so OSMD has reserved room for them.
 */
function headroom(page: PageGeometry, staff: StaffGeometry): { up: number; down: number } {
  const staffBottom = staff.topY + staff.lineGap * 4;
  const steps = (gap: number) =>
    Math.max(0, Math.min(MAX_POSITIONS_BEYOND, Math.floor(gap / (staff.lineGap / 2))));

  const below = page.staves
    .filter((other) => other.topY > staffBottom)
    .sort((a, b) => a.topY - b.topY)[0];
  const above = page.staves
    .filter((other) => other.topY + other.lineGap * 4 < staff.topY)
    .sort((a, b) => b.topY - a.topY)[0];

  return {
    // Stop a full space short of the neighbour so the two never touch.
    down: below ? steps(below.topY - staffBottom - staff.lineGap) : MAX_POSITIONS_BEYOND,
    up: above
      ? steps(staff.topY - (above.topY + above.lineGap * 4) - staff.lineGap)
      : MAX_POSITIONS_BEYOND,
  };
}

const sameClef = (a: Clef, b: Clef): boolean =>
  a.sign === b.sign && a.line === b.line && a.octaveChange === b.octaveChange;

interface Anchor {
  /** Left edge of the letter column, in page-local pixels. */
  x: number;
  /** Rightmost x the column may use before it would touch the music. */
  limitX: number;
  /** Right edge of the row bands. */
  bandRight: number;
  clef: Clef;
  measureIndex: number;
  /**
   * Printed span across every measure this column speaks for, or null when they
   * hold no notes. Drives how far the column extends above and below the staff.
   */
  lowestPrinted: number | null;
  highestPrinted: number | null;
}

/**
 * Where to draw a letter column on one staff of one system.
 *
 * In per-measure mode every measure gets its own column, in the space reserved
 * by EngravingRules.MeasureLeftMargin. In per-line mode there is one column in
 * the page margin, plus an extra wherever the clef changes part-way along a
 * line, since the rest of that line would otherwise be labelled wrongly.
 */
function anchorsFor(
  score: ParsedScore,
  staff: StaffGeometry,
  scale: number,
  options: GutterOptions,
): Anchor[] {
  const out: Anchor[] = [];
  let previous: Clef | null = null;

  staff.measures.forEach((measure, index) => {
    const clef = clefAt(score, measure.measureIndex, staff.staffIndex);
    const isFirst = index === 0;
    const changed = previous !== null && !sameClef(clef, previous);
    previous = clef;

    const extent = extentAt(score, measure.measureIndex, staff.staffIndex);
    const lowest = extent?.lowest ?? null;
    const highest = extent?.highest ?? null;

    const inkWidth = gutterInkUnits(options) * scale;
    const carryOn = options.mode !== 'measure' && !isFirst && !changed;
    const current = out[out.length - 1];
    if (carryOn && current) {
      // This measure shares the column already drawn at the start of the line,
      // so that column has to reach low enough for this measure's notes too.
      current.bandRight = measure.x + measure.width;
      if (lowest !== null) {
        current.lowestPrinted =
          current.lowestPrinted === null ? lowest : Math.min(current.lowestPrinted, lowest);
      }
      if (highest !== null) {
        current.highestPrinted =
          current.highestPrinted === null ? highest : Math.max(current.highestPrinted, highest);
      }
      return;
    }

    // The per-line column sits in the reserved page margin, left of the staff;
    // a per-measure column sits inside the measure's own left margin.
    const useStaffLeft = isFirst && options.mode !== 'measure';
    const x = useStaffLeft ? staff.leftX - inkWidth : measure.x;
    out.push({
      x,
      // In the page margin the room is ours by construction. Inside a measure
      // it runs out wherever the first note starts.
      limitX: useStaffLeft ? staff.leftX : (measure.firstEntryX ?? measure.x + measure.width),
      bandRight: measure.x + measure.width,
      clef,
      measureIndex: measure.measureIndex,
      lowestPrinted: lowest,
      highestPrinted: highest,
    });
  });

  return out;
}

function drawColumn(
  parent: SVGGElement,
  scale: number,
  staff: StaffGeometry,
  anchor: Anchor,
  room: { up: number; down: number },
  options: GutterOptions,
): boolean {
  const { clef } = anchor;
  const bottomLine = bottomLineDiatonic(clef);

  // Reach past the staff far enough to name the highest and lowest notes printed
  // here, so ledger-line notes get named too, but never into a neighbouring staff.
  const reachDown = anchor.lowestPrinted === null ? 0 : anchor.lowestPrinted - bottomLine;
  const reachUp = anchor.highestPrinted === null ? 8 : anchor.highestPrinted - bottomLine;
  const lowIndex = Math.max(-room.down, Math.min(-options.ledgerPositions * 2, reachDown));
  const highIndex = Math.min(8 + room.up, Math.max(8 + options.ledgerPositions * 2, reachUp));

  const columnLeft = anchor.x;
  const fontPx = scale * LETTER_SIZE_UNITS;
  const inkFactor = options.showOctaves ? INK_FACTOR_OCTAVES : INK_FACTOR_PLAIN;
  // The staff-entry x sits at the notehead's centre, so back off by roughly a
  // half notehead plus a little air.
  const available = anchor.limitX - columnLeft - scale * 0.7;

  // Letter size is fixed everywhere, so in the rare measure too tight to hold the
  // column we drop the letters rather than shrink them. The coloured rows and
  // their rules are still drawn: the colour coding stays unbroken across the
  // score, and the neighbouring measures' letters still name those rows.
  const fitsLabels = available >= fontPx * inkFactor;

  const positions = positionsFor(clef, lowIndex, highIndex);

  // Lines take the outer sub-column, spaces the inner one.
  const lineX = columnLeft + fontPx * 0.05;
  const spaceX = columnLeft + fontPx * (options.showOctaves ? 1.7 : 0.74);

  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'gutter-column');
  group.setAttribute('data-clef', `${clef.sign}${clef.line}`);
  group.setAttribute('data-staff', String(staff.staffIndex));
  group.setAttribute('data-measure', String(anchor.measureIndex));
  group.setAttribute('data-low', String(lowIndex));
  group.setAttribute('data-high', String(highIndex));
  group.setAttribute('data-labels', String(fitsLabels));
  group.setAttribute('data-font', fontPx.toFixed(1));
  parent.appendChild(group);
  const staffBottomY = staff.topY + staff.lineGap * 4;

  for (const position of positions) {
    // index 0 is the bottom line; each step is half a line gap upward.
    const y = staffBottomY - (position.index * staff.lineGap) / 2;
    const color = colorFor(position.letter);

    // Outside the five real staff lines there is nothing for the eye to follow,
    // so continue the staff with a dotted rule at each would-be ledger line.
    // Without it the coloured rows float and are hard to trace back to a letter.
    const isLedgerLine = position.isLine && (position.index < 0 || position.index > 8);
    if (isLedgerLine) {
      const rule = document.createElementNS(SVG_NS, 'line');
      rule.setAttribute('class', 'gutter-ledger-rule');
      rule.setAttribute('x1', String(columnLeft));
      rule.setAttribute('y1', String(y));
      rule.setAttribute('x2', String(anchor.bandRight));
      rule.setAttribute('y2', String(y));
      if (options.colorByLetter) rule.setAttribute('stroke', color.ink);
      group.appendChild(rule);
    }

    if (options.showBands) {
      const band = document.createElementNS(SVG_NS, 'rect');
      band.setAttribute('class', 'gutter-band');
      band.setAttribute('x', String(columnLeft));
      band.setAttribute('y', String(y - staff.lineGap / 4));
      band.setAttribute('width', String(Math.max(1, anchor.bandRight - columnLeft)));
      band.setAttribute('height', String(staff.lineGap / 2));
      band.setAttribute('fill', options.colorByLetter ? color.band : 'rgba(120,130,140,0.10)');
      group.appendChild(band);
    }

    if (!fitsLabels) continue;

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', String(position.isLine ? lineX : spaceX));
    label.setAttribute('y', String(y));
    label.setAttribute('font-size', String(fontPx));
    label.setAttribute('dominant-baseline', 'middle');
    label.setAttribute('text-anchor', 'start');
    label.setAttribute(
      'class',
      `gutter-letter ${position.isLine ? 'gutter-letter-line' : 'gutter-letter-space'}`,
    );
    if (options.colorByLetter) label.setAttribute('fill', color.ink);
    label.textContent = options.showOctaves
      ? `${position.letter}${position.octave}`
      : position.letter;
    group.appendChild(label);
  }

  return fitsLabels;
}
