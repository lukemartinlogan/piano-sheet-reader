import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import type { ParsedScore } from '../score/types';
import { clefAt } from '../score/types';
import { collectGeometry, type MeasureBox, type StaffGeometry } from './geometry';
import { bottomLineDiatonic, letterForDiatonic } from './staffPositions';
import { colorFor } from './palette';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LAYER_ATTR = 'data-note-letters';

export interface NoteLetterOptions {
  enabled: boolean;
  /** Tint the notehead itself with the letter's colour. */
  colorByLetter: boolean;
}

/** Remove note letters drawn by a previous pass. */
export function clearNoteLetters(osmd: OpenSheetMusicDisplay): void {
  const container: HTMLElement | undefined = (osmd as any).container;
  container?.querySelectorAll(`[${LAYER_ATTR}]`).forEach((el) => el.remove());
}

/**
 * Print each note's letter name inside its own notehead.
 *
 * The letter comes from where the notehead actually sits on the staff, converted
 * through the clef in force, so it always agrees with the margin guide — and
 * with any octave-shift bracket, since both read printed position.
 *
 * Drawn into a layer appended last, so the letters sit above the noteheads.
 */
export function drawNoteLetters(
  osmd: OpenSheetMusicDisplay,
  score: ParsedScore,
  options: NoteLetterOptions,
): void {
  clearNoteLetters(osmd);
  if (!options.enabled) return;

  const kinds = collectNoteKinds(osmd);

  for (const page of collectGeometry(osmd)) {
    const layer = document.createElementNS(SVG_NS, 'g');
    layer.setAttribute(LAYER_ATTR, 'true');
    layer.setAttribute('class', 'note-letters');
    page.svg.appendChild(layer);

    let unmatched = 0;
    for (const group of Array.from(page.svg.querySelectorAll('g.vf-measure'))) {
      const located = locate(group as SVGGElement, page.staves);
      if (!located) {
        // Only measures that actually hold notes matter: an unplaceable empty
        // or rest-only measure costs nothing, but an unplaceable one with notes
        // loses every letter in it.
        if (group.querySelector('g.vf-notehead')) unmatched++;
        continue;
      }
      const { staff, measure } = located;
      const clef = clefAt(score, measure.measureIndex, staff.staffIndex);
      const bottomLine = bottomLineDiatonic(clef);
      const staffBottomY = staff.topY + staff.lineGap * 4;

      for (const notehead of Array.from(group.querySelectorAll('g.vf-notehead'))) {
        const kind = kinds.get(notehead.closest('g.vf-stavenote') as Element);
        if (kind?.isRest) continue;
        label(layer, notehead as SVGGElement, staff, measure, staffBottomY, bottomLine, options);
      }
    }

    // A measure we cannot place gets no letters at all, which is invisible from
    // the outside — and the drift that causes it grows down the page, so it
    // shows up as "the first few rows work". Publish the count so a check fails.
    layer.setAttribute('data-unmatched-measures', String(unmatched));
  }
}

/** What a rendered `vf-stavenote` group actually contains. */
interface NoteKind {
  isRest: boolean;
}

/** VexFlow uses a fully transparent fill for the contour that forms a hole. */
function isTransparentFill(fill: string | null): boolean {
  if (!fill || fill === 'none') return true;
  if (/^#[0-9a-f]{6}00$/i.test(fill)) return true;
  return /rgba\([^)]*,\s*0(\.0+)?\)$/i.test(fill);
}

/**
 * Whether a notehead is drawn as an outline with a hole through it.
 *
 * Read from the glyph itself rather than from the note's duration: what decides
 * whether a white letter is visible is what was actually drawn, and the two
 * disagree on a small number of heads. A filled head's outline is a single
 * contour (two move commands); a hollow one adds the inner contour that forms
 * the hole.
 */
function isHollowHead(notehead: SVGGElement): boolean {
  let moves = 0;
  for (const path of Array.from(notehead.querySelectorAll('path'))) {
    moves += (path.getAttribute('d') ?? '').match(/[Mm]/g)?.length ?? 0;
  }
  return moves >= 3;
}

/**
 * Classify each rendered note group using OSMD's model.
 *
 * The DOM cannot answer either question: a rest is drawn as
 * `vf-stavenote > vf-note > vf-notehead`, exactly like a pitched note and with
 * no distinguishing class, and nothing marks a notehead as hollow.
 */
function collectNoteKinds(osmd: OpenSheetMusicDisplay): Map<Element, NoteKind> {
  const found = new Map<Element, NoteKind>();
  const graphic = (osmd as any).GraphicSheet ?? (osmd as any).graphic;
  for (const page of graphic?.MusicPages ?? []) {
    for (const system of page.MusicSystems ?? []) {
      for (const line of system.StaffLines ?? []) {
        for (const measure of line.Measures ?? []) {
          for (const entry of measure.staffEntries ?? []) {
            for (const voice of entry.graphicalVoiceEntries ?? []) {
              const vf = (voice as any).vfStaveNote;
              const element: Element | undefined = vf?.attrs?.el;
              if (!element) continue;
              found.set(element, {
                isRest: typeof vf.isRest === 'function' ? vf.isRest() : false,
              });
            }
          }
        }
      }
    }
  }
  return found;
}

/**
 * Work out which staff and measure a rendered measure group belongs to.
 *
 * VexFlow draws each measure's own five stave lines inside its group, so their
 * position identifies the staff exactly. Matching on the group's bounding box
 * instead does not work: the box also covers beams and ledger lines, which
 * routinely reach into the neighbouring staff.
 */
function locate(
  group: SVGGElement,
  staves: StaffGeometry[],
): { staff: StaffGeometry; measure: MeasureBox } | null {
  let topLineY = Infinity;
  let leftX = Infinity;
  for (const path of Array.from(group.children)) {
    if (path.tagName !== 'path') continue;
    let box: DOMRect;
    try {
      box = (path as SVGPathElement).getBBox();
    } catch {
      continue;
    }
    // Horizontal rules are the stave lines; the vertical ones are barlines.
    if (box.height > 2 || box.width < 20) continue;
    topLineY = Math.min(topLineY, box.y + box.height / 2);
    leftX = Math.min(leftX, box.x);
  }
  if (!Number.isFinite(topLineY)) return null;

  // Nearest staff, not a fixed tolerance. Staves in a system sit many spaces
  // apart, so the nearest is unambiguous, and a hard threshold would silently
  // drop every measure below the point where any small drift exceeded it.
  let staff: StaffGeometry | null = null;
  let staffDistance = Infinity;
  for (const candidate of staves) {
    const distance = Math.abs(candidate.topY - topLineY);
    if (distance < staffDistance) {
      staffDistance = distance;
      staff = candidate;
    }
  }
  if (!staff || staffDistance > staff.lineGap * 2) return null;

  // Match on nearest measure start, not on range containment: OSMD's measure
  // boxes overlap by a hair, so a group sitting exactly on a boundary would
  // otherwise be claimed by the previous measure.
  let measure: MeasureBox | null = null;
  let best = Infinity;
  for (const candidate of staff.measures) {
    const distance = Math.abs(candidate.x - leftX);
    if (distance < best) {
      best = distance;
      measure = candidate;
    }
  }
  if (measure && best <= staff.lineGap * 3) return { staff, measure };
  return null;
}

function label(
  layer: SVGGElement,
  notehead: SVGGElement,
  staff: StaffGeometry,
  measure: MeasureBox,
  staffBottomY: number,
  bottomLine: number,
  options: NoteLetterOptions,
): void {
  let box: DOMRect;
  try {
    box = notehead.getBBox();
  } catch {
    return; // Not rendered.
  }
  if (box.width <= 0 || box.height <= 0) return;

  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  // Staff position, counting half-spaces up from the bottom line.
  const index = Math.round((staffBottomY - centerY) / (staff.lineGap / 2));
  const letter = letterForDiatonic(bottomLine + index);

  const color = colorFor(letter);
  const isHollow = isHollowHead(notehead);

  // A hollow head has room to carry the colour on its own outline, which leaves
  // the letter free to be plain black — far easier to read at this size than a
  // coloured letter in a small white hole. Filled heads stay black and let the
  // letter carry the colour instead.
  if (isHollow && options.colorByLetter) {
    for (const path of Array.from(notehead.querySelectorAll('path'))) {
      // Skip the transparent contour that punches the hole; filling it would
      // turn the note solid and lose its duration.
      if (isTransparentFill(path.getAttribute('fill'))) continue;
      path.setAttribute('fill', color.ink);
    }
  }

  // Fit inside the head rather than merely centring on it. Oversized letters
  // spill past the notehead, cover the hole that makes a half note read as a
  // half note, and let neighbouring letters in a stacked chord collide — chord
  // tones a third apart are only one staff space (one notehead height) apart.
  const fontPx = Math.min(box.height * 0.88, box.width * 0.8);

  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', String(centerX));
  text.setAttribute('y', String(centerY));
  text.setAttribute('font-size', String(fontPx));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  // Noteheads keep their own colour, so the letter has to carry the coding and
  // still contrast with the head it sits on: a filled head is solid black, so
  // the letter takes the bright weight; a hollow head's centre is the white
  // page, so it takes the dark one. Set through style, not a fill attribute: a
  // presentation attribute loses to any CSS rule, which silently turned every
  // letter white and made the ones on hollow heads invisible.
  const onBlack = !isHollow;
  text.style.fill = onBlack ? (options.colorByLetter ? color.onDark : '#ffffff') : '#000000';
  text.style.stroke = onBlack ? 'rgba(0, 0, 0, 0.85)' : 'rgba(255, 255, 255, 0.95)';
  text.setAttribute('class', 'note-letter');
  text.setAttribute('data-hollow', String(isHollow));
  text.setAttribute('data-staff', String(staff.staffIndex));
  text.setAttribute('data-measure', String(measure.measureIndex));
  text.textContent = letter;
  layer.appendChild(text);
}
