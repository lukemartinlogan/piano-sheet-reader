/**
 * The PDF reading layer: glyphs and vector shapes, in page coordinates.
 *
 * This module knows nothing about music. It answers one question — what did
 * this page draw, and where — and leaves the interpretation to pdfScore.
 *
 * Two things need care. Glyph positions arrive in PDF user space (y up from the
 * bottom) while path coordinates arrive in the content stream's own space, so
 * both are normalised here to y *down* from the top of the page: the order
 * music is read in, and the order everything downstream assumes. And paths are
 * delivered as sub-arrays of interleaved opcodes and coordinates, which have to
 * be walked with the current transform applied.
 */

/** A drawn character: which glyph, where its origin sits, and how big it is. */
export interface PdfGlyph {
  /** Unicode code point the font maps this glyph to. */
  code: number;
  x: number;
  /** Baseline, measured down from the top of the page. */
  y: number;
  /** Font size in points. In a SMuFL font this is one staff height. */
  size: number;
  page: number;
}

/** A drawn path, reduced to the bounding box and whether it curves. */
export interface PdfShape {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Corner points, for shapes whose slant matters (beams). */
  points: { x: number; y: number }[];
  curved: boolean;
  page: number;
}

export interface PdfPageContent {
  page: number;
  width: number;
  height: number;
  glyphs: PdfGlyph[];
  shapes: PdfShape[];
}

export interface PdfDocumentContent {
  /** From the PDF's own metadata; '' when it carries none. */
  title: string;
  pages: PdfPageContent[];
}

/** The slice of pdf.js this module uses, so the loader can be swapped in Node. */
export interface PdfjsLike {
  getDocument(source: { data: Uint8Array; useSystemFonts?: boolean }): { promise: Promise<any> };
  OPS: Record<string, number>;
  GlobalWorkerOptions?: { workerSrc: string };
}

let injected: PdfjsLike | null = null;

/**
 * Supply the pdf.js build to use. The browser bundle and the Node build are
 * different entry points, so the Node-side scripts inject theirs rather than
 * making this module guess which environment it is in.
 */
export function usePdfjs(lib: PdfjsLike): void {
  injected = lib;
}

async function library(): Promise<PdfjsLike> {
  if (injected) return injected;
  const pdfjs = await import('pdfjs-dist');
  // The worker is bundled as an asset; without it pdf.js refuses to start.
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs as unknown as PdfjsLike;
}

export const isPdfFile = (bytes: Uint8Array): boolean =>
  bytes.length > 4 &&
  bytes[0] === 0x25 && // %
  bytes[1] === 0x50 && // P
  bytes[2] === 0x44 && // D
  bytes[3] === 0x46; // F

/** Compose two matrices so that `apply(compose(a, b), p)` means "b then a". */
const compose = (m: number[], n: number[]): number[] => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

const applyMatrix = (m: number[], x: number, y: number) => ({
  x: m[0] * x + m[2] * y + m[4],
  y: m[1] * x + m[3] * y + m[5],
});

/** Accept a matrix passed either as six loose numbers or as one wrapped array. */
function readMatrix(args: any): number[] {
  const source = args?.length === 6 ? args : args?.[0];
  const matrix = Array.from(source ?? []) as number[];
  return matrix.length === 6 && matrix.every(Number.isFinite) ? matrix : [1, 0, 0, 1, 0, 0];
}

/**
 * Sub-path opcodes, as pdf.js emits them inside constructPath. These are its
 * internal drawing codes (moveTo, lineTo, curveTo, quadraticCurveTo,
 * closePath), not the OPS enum, and the coordinate count per opcode is what
 * keeps the walk in step — miss one and the rest of the path decodes to
 * nonsense, or is dropped entirely.
 */
const SUBPATH_COORDS: Record<number, number> = { 0: 2, 1: 2, 2: 6, 3: 4, 4: 0 };

export async function extractPdf(data: ArrayBuffer): Promise<PdfDocumentContent> {
  const pdfjs = await library();
  const document = await pdfjs.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
  }).promise;

  let title = '';
  try {
    const metadata = await document.getMetadata();
    title = (metadata?.info?.Title ?? '').trim();
  } catch {
    // Metadata is optional.
  }

  const pages: PdfPageContent[] = [];
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const { glyphs, shapes } = await readPage(page, pdfjs.OPS, number, viewport.height);
    pages.push({
      page: number,
      width: viewport.width,
      height: viewport.height,
      glyphs,
      shapes,
    });
    page.cleanup?.();
  }
  await document.destroy?.();
  return { title, pages };
}

/**
 * Read a page's glyphs and paths in a single pass.
 *
 * Both come out of the operator list under the same transform, which matters
 * for two reasons. Glyph positions have to be *computed* from the text matrix
 * and each glyph's own advance width — pdf.js's convenience text API merges a
 * run into one item, and spreading a run's glyphs evenly across its width puts
 * every notehead a point or two off, which is enough to stop a notehead ever
 * finding its own stem. And sharing the transform chain means glyphs and paths
 * land in one coordinate frame, so a notehead can be compared with the stem and
 * beams that give it its value.
 */
async function readPage(
  page: any,
  OPS: Record<string, number>,
  number: number,
  height: number,
): Promise<{ glyphs: PdfGlyph[]; shapes: PdfShape[] }> {
  const operators = await page.getOperatorList();
  const glyphs: PdfGlyph[] = [];
  const shapes: PdfShape[] = [];

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];

  // Text state.
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  let fontSize = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let hScale = 1;
  let leading = 0;
  let rise = 0;

  const translate = (x: number, y: number) => [1, 0, 0, 1, x, y];

  const showGlyphs = (items: any[]): void => {
    for (const item of items ?? []) {
      if (typeof item === 'number') {
        // A kerning adjustment, in thousandths of the font size.
        tm = compose(tm, translate((-item / 1000) * fontSize * hScale, 0));
        continue;
      }
      if (!item || typeof item !== 'object') continue;

      const full = compose(ctm, compose(tm, [fontSize * hScale, 0, 0, fontSize, 0, rise]));
      const origin = applyMatrix(compose(ctm, tm), 0, rise);
      const code = item.unicode ? item.unicode.codePointAt(0) : item.fontChar?.codePointAt(0);
      if (code !== undefined && !item.isSpace) {
        glyphs.push({
          code,
          x: origin.x,
          y: origin.y,
          size: Math.hypot(full[2], full[3]),
          page: number,
        });
      }

      const advance =
        ((item.width ?? 0) / 1000) * fontSize + charSpacing + (item.isSpace ? wordSpacing : 0);
      tm = compose(tm, translate(advance * hScale, 0));
    }
  };

  for (let i = 0; i < operators.fnArray.length; i++) {
    const fn = operators.fnArray[i];
    const args = operators.argsArray[i];

    if (fn === OPS.save) {
      stack.push([...ctm]);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    } else if (fn === OPS.transform) {
      ctm = compose(ctm, readMatrix(args));
    } else if (fn === OPS.beginText) {
      tm = [1, 0, 0, 1, 0, 0];
      tlm = [...tm];
    } else if (fn === OPS.setTextMatrix) {
      // Delivered as a single wrapped matrix here, unlike `transform`, which
      // passes six loose numbers.
      tm = readMatrix(args);
      tlm = [...tm];
    } else if (fn === OPS.setFont) {
      fontSize = args[1];
    } else if (fn === OPS.setCharSpacing) {
      charSpacing = args[0];
    } else if (fn === OPS.setWordSpacing) {
      wordSpacing = args[0];
    } else if (fn === OPS.setHScale) {
      hScale = args[0] / 100;
    } else if (fn === OPS.setLeading) {
      leading = args[0];
    } else if (fn === OPS.setTextRise) {
      rise = args[0];
    } else if (fn === OPS.moveText) {
      tlm = compose(tlm, translate(args[0], args[1]));
      tm = [...tlm];
    } else if (fn === OPS.setLeadingMoveText) {
      leading = -args[1];
      tlm = compose(tlm, translate(args[0], args[1]));
      tm = [...tlm];
    } else if (fn === OPS.nextLine) {
      tlm = compose(tlm, translate(0, -leading));
      tm = [...tlm];
    } else if (fn === OPS.showText) {
      showGlyphs(args[0]);
    } else if (fn === OPS.showSpacedText) {
      showGlyphs(args[0]);
    } else if (fn === OPS.nextLineShowText) {
      tlm = compose(tlm, translate(0, -leading));
      tm = [...tlm];
      showGlyphs(args[0]);
    } else if (fn === OPS.nextLineSetSpacingShowText) {
      wordSpacing = args[0];
      charSpacing = args[1];
      tlm = compose(tlm, translate(0, -leading));
      tm = [...tlm];
      showGlyphs(args[2]);
    } else if (fn === OPS.constructPath) {
      const subpaths = args[1];
      if (!Array.isArray(subpaths)) continue;

      // One shape per sub-path. A single path object routinely holds several
      // separate figures — an engraver draws a whole system's barlines in one
      // go — and merging them into one bounding box turns five thin verticals
      // into one page-wide blob that matches nothing.
      for (const sub of subpaths) {
        const points: { x: number; y: number }[] = [];
        let curved = false;
        let cursor = 0;
        while (cursor < sub.length) {
          const opcode = sub[cursor++];
          const take = SUBPATH_COORDS[opcode];
          if (take === undefined || cursor + take > sub.length) break; // unknown opcode: stop
          if (opcode === 2 || opcode === 3) curved = true;
          for (let k = 0; k < take; k += 2) {
            points.push(applyMatrix(ctm, sub[cursor + k], sub[cursor + k + 1]));
          }
          cursor += take;
        }
        if (points.length === 0) continue;

        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (const point of points) {
          if (point.x < x0) x0 = point.x;
          if (point.x > x1) x1 = point.x;
          if (point.y < y0) y0 = point.y;
          if (point.y > y1) y1 = point.y;
        }
        if (!Number.isFinite(x0) || !Number.isFinite(y0)) continue;
        shapes.push({ x0, y0, x1, y1, points, curved, page: number });
      }
    }
  }

  // Operator-list coordinates are PDF user space, which runs y *up* from the
  // bottom of the page. Flip once, here, so everything downstream can read the
  // page the way music is read: top to bottom.
  for (const glyph of glyphs) glyph.y = height - glyph.y;
  for (const shape of shapes) {
    for (const point of shape.points) point.y = height - point.y;
    const y0 = height - shape.y1;
    shape.y1 = height - shape.y0;
    shape.y0 = y0;
  }

  return { glyphs, shapes };
}
