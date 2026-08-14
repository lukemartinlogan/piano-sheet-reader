/**
 * PDF -> MusicXML.
 *
 * The two halves are deliberately separate: pdfContent answers "what did this
 * page draw and where", pdfScore answers "what music is that". This joins them
 * and is the only entry point the rest of the app uses.
 */
import { extractPdf } from './pdfContent';
import { buildScoreFromPdf, type PdfScoreResult } from './pdfScore';

export type { PdfImportStats, PdfScoreResult } from './pdfScore';

export async function pdfToMusicXml(data: ArrayBuffer, filename: string): Promise<PdfScoreResult> {
  const { title, pages } = await extractPdf(data);
  if (pages.length === 0) throw new Error(`${filename} has no pages.`);
  return buildScoreFromPdf(pages, filename, title);
}

/** One line describing how much of the rhythm could be verified. */
export function describeImport(result: PdfScoreResult): string | null {
  const { measures, exactMeasures, fallbackMeasures } = result.stats;
  if (measures === 0) return null;
  if (exactMeasures === measures) return null;
  const percent = Math.round((exactMeasures / measures) * 100);
  return (
    `Read ${result.stats.notes} notes from ${result.stats.pages} pages. ` +
    `Pitches come straight off the page; rhythm was verified against the time signature in ` +
    `${exactMeasures} of ${measures} bars (${percent}%)` +
    (fallbackMeasures > 0 ? `, and ${fallbackMeasures} were spaced by position instead.` : '.')
  );
}
