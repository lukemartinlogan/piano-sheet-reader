import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { collectGeometry, type PageGeometry } from './geometry';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HIGHLIGHT_ATTR = 'data-measure-highlight';

/** Cached page geometry; rebuilt only when the score is re-rendered. */
export class MeasureHighlighter {
  private pages: PageGeometry[] = [];
  private current = -1;

  constructor(private readonly osmd: OpenSheetMusicDisplay) {}

  /** Call after every OSMD render, once the SVG is in the DOM. */
  refresh(): void {
    this.pages = collectGeometry(this.osmd);
    this.current = -1;
  }

  clear(): void {
    const container: HTMLElement | undefined = (this.osmd as any).container;
    container?.querySelectorAll(`[${HIGHLIGHT_ATTR}]`).forEach((el) => el.remove());
    this.current = -1;
  }

  /**
   * Highlight the given measure across every staff of its system.
   * Returns the drawn rect so the caller can scroll it into view.
   */
  show(measureIndex: number): SVGRectElement | null {
    if (measureIndex === this.current) {
      const existing = (this.osmd as any).container?.querySelector(`[${HIGHLIGHT_ATTR}]`);
      return (existing as SVGRectElement) ?? null;
    }
    this.clear();
    this.current = measureIndex;

    for (const page of this.pages) {
      // Staves in the same system share the highlight, so both hands light up.
      const hits = page.staves
        .map((staff) => ({ staff, box: staff.measures.find((m) => m.measureIndex === measureIndex) }))
        .filter((hit): hit is { staff: (typeof page.staves)[number]; box: NonNullable<typeof hit.box> } =>
          Boolean(hit.box),
        );
      if (hits.length === 0) continue;

      const systemIndex = hits[0].staff.systemIndex;
      const inSystem = hits.filter((hit) => hit.staff.systemIndex === systemIndex);

      const left = Math.min(...inSystem.map((hit) => hit.box.x));
      const right = Math.max(...inSystem.map((hit) => hit.box.x + hit.box.width));
      const pad = page.scale * 0.8;
      const top = Math.min(...inSystem.map((hit) => hit.staff.topY)) - pad;
      const bottom = Math.max(...inSystem.map((hit) => hit.staff.topY + hit.staff.lineGap * 4)) + pad;

      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute(HIGHLIGHT_ATTR, 'true');
      rect.setAttribute('class', 'measure-highlight');
      rect.setAttribute('x', String(left));
      rect.setAttribute('y', String(top));
      rect.setAttribute('width', String(Math.max(1, right - left)));
      rect.setAttribute('height', String(Math.max(1, bottom - top)));
      rect.setAttribute('rx', String(page.scale * 0.3));
      // Behind the notes so nothing is obscured.
      page.svg.insertBefore(rect, page.svg.firstChild);
      return rect;
    }

    return null;
  }
}

/** Find the measure sounding at a given time. */
export function measureAt(measureStarts: number[], seconds: number): number {
  let lo = 0;
  let hi = measureStarts.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureStarts[mid] <= seconds) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
