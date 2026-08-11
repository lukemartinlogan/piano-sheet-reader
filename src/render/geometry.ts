import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';

export interface MeasureBox {
  measureIndex: number;
  /** Page-local pixels. */
  x: number;
  width: number;
  /**
   * x of the leftmost note/rest in this measure, or null if it has none.
   * This is the hard limit for how much room the letter column may take:
   * OSMD treats the measure margin as a hint and compresses it while
   * justifying a system, so the space asked for is not the space granted.
   */
  firstEntryX: number | null;
}

export interface StaffGeometry {
  /** y of the top staff line, in page-local pixels. */
  topY: number;
  /** Vertical distance between adjacent staff lines, in pixels. */
  lineGap: number;
  /** x of the staff's left edge, in page-local pixels. */
  leftX: number;
  width: number;
  staffIndex: number;
  /** Index of the system this staff belongs to, within the page. */
  systemIndex: number;
  measures: MeasureBox[];
}

/** OSMD's nominal unit-to-pixel ratio inside the SVG coordinate system. */
const UNIT_PX = 10;

/**
 * Pixels per OSMD unit, measured from the staff lines the renderer actually drew.
 *
 * One OSMD unit is one staff space by definition, so the gap between adjacent
 * staff lines *is* the scale. Reading it from the page beats inferring it from
 * the viewBox: an inference that is wrong by a factor makes every y drift in
 * proportion to its distance down the page, so the top of the score still lines
 * up while everything below it silently stops matching.
 */
function measureUnitScale(svg: SVGSVGElement, zoom: number): number {
  const measures = Array.from(svg.querySelectorAll('g.vf-measure')).slice(0, 8);
  const gaps: number[] = [];

  for (const measure of measures) {
    const ys: number[] = [];
    for (const child of Array.from(measure.children)) {
      if (child.tagName !== 'path') continue;
      let box: DOMRect;
      try {
        box = (child as SVGPathElement).getBBox();
      } catch {
        continue;
      }
      // Horizontal rules are the stave lines; barlines are vertical.
      if (box.height > 2 || box.width < 20) continue;
      ys.push(box.y + box.height / 2);
    }
    if (ys.length < 5) continue;
    ys.sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) gaps.push(ys[i] - ys[i - 1]);
  }

  if (gaps.length === 0) {
    // Nothing drawn yet to measure; fall back to the viewBox relationship.
    const viewBoxWidth = svg.viewBox?.baseVal?.width ?? 0;
    return viewBoxWidth > 0 ? UNIT_PX : UNIT_PX * zoom;
  }

  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return median > 0.5 ? median : UNIT_PX;
}

export interface PageGeometry {
  svg: SVGSVGElement;
  /** Pixels per OSMD unit on this page. */
  scale: number;
  staves: StaffGeometry[];
}

/**
 * Read OSMD's internal graphic model and convert it to page-local pixels.
 *
 * OSMD's public typings only partly cover the graphic model, so the reads below
 * are defensive: every field has a fallback, and the unit->pixel ratio is
 * calibrated against the emitted SVG rather than assumed.
 */
export function collectGeometry(osmd: OpenSheetMusicDisplay): PageGeometry[] {
  const graphic = (osmd as any).GraphicSheet ?? (osmd as any).graphic;
  const container: HTMLElement | undefined = (osmd as any).container;
  if (!graphic || !container) return [];

  const svgs = Array.from(container.querySelectorAll('svg')) as SVGSVGElement[];
  const zoom = (osmd as any).zoom ?? 1;
  const pages = graphic.MusicPages ?? [];
  const out: PageGeometry[] = [];

  pages.forEach((page: any, pageIndex: number) => {
    const svg = svgs[pageIndex];
    if (!svg) return;

    const scale = measureUnitScale(svg, zoom);

    const origin = page.PositionAndShape?.AbsolutePosition ?? { x: 0, y: 0 };
    const staves: StaffGeometry[] = [];

    (page.MusicSystems ?? []).forEach((system: any, systemIndex: number) => {
      (system.StaffLines ?? []).forEach((staffLine: any, indexInSystem: number) => {
        const box = staffLine.PositionAndShape;
        if (!box?.AbsolutePosition) return;

        // A five-line staff spans four units; derive the gap from the measured
        // height when it looks sane, otherwise assume the standard one unit.
        const heightUnits = box.Size?.height ?? 0;
        const lineGap = (heightUnits > 3 && heightUnits < 5 ? heightUnits / 4 : 1) * scale;

        const parentStaff = staffLine.ParentStaff ?? staffLine.parentStaff;
        const rawStaffIndex =
          parentStaff?.idInMusicSheet ??
          (typeof parentStaff?.Id === 'number' ? parentStaff.Id - 1 : undefined);

        staves.push({
          topY: (box.AbsolutePosition.y - origin.y) * scale,
          leftX: (box.AbsolutePosition.x - origin.x) * scale,
          width: (box.Size?.width ?? 0) * scale,
          lineGap,
          staffIndex: typeof rawStaffIndex === 'number' ? rawStaffIndex : indexInSystem,
          systemIndex,
          measures: (staffLine.Measures ?? []).map((measure: any): MeasureBox => {
            const source = measure.parentSourceMeasure ?? measure.ParentSourceMeasure;
            const measureIndex =
              source?.measureListIndex ??
              (typeof measure.MeasureNumber === 'number' ? measure.MeasureNumber - 1 : 0);
            const entries = measure.staffEntries ?? measure.StaffEntries ?? [];
            const entryXs = entries
              .map((entry: any) => entry?.PositionAndShape?.AbsolutePosition?.x)
              .filter((x: unknown): x is number => typeof x === 'number');

            return {
              measureIndex: Math.max(0, measureIndex),
              x: ((measure.PositionAndShape?.AbsolutePosition?.x ?? 0) - origin.x) * scale,
              width: (measure.PositionAndShape?.Size?.width ?? 0) * scale,
              firstEntryX: entryXs.length > 0 ? (Math.min(...entryXs) - origin.x) * scale : null,
            };
          }),
        });
      });
    });

    out.push({ svg, scale, staves });
  });

  return out;
}
