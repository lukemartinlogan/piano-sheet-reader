import JSZip from 'jszip';
import { isMidiFile } from './midiFile';
import { midiToMusicXml } from './midiToMusicXml';
import { isPdfFile } from './pdf/pdfContent';
import { describeImport, pdfToMusicXml } from './pdf/pdfToMusicXml';

/** Where the notation came from, which is worth telling the reader. */
export type ScoreSource = 'musicxml' | 'midi' | 'pdf';

export interface LoadedScore {
  /** Raw MusicXML text, ready for both OSMD and our own parser. */
  xml: string;
  doc: Document;
  filename: string;
  source: ScoreSource;
  /** How well an import went, when that is worth saying out loud. */
  notice: string | null;
}

const isZip = (bytes: Uint8Array): boolean =>
  bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);

/**
 * Read a score.
 *
 * `.musicxml`/`.xml` are read as they are, `.mxl` is unwrapped, and `.mid` and
 * `.pdf` are transcribed into MusicXML so that everything downstream — the
 * renderer, the letter guide, the parser — only ever sees one format.
 *
 * The format is taken from the file's own bytes rather than its extension, so a
 * mislabelled file still opens.
 */
export async function loadMusicXml(data: ArrayBuffer, filename: string): Promise<LoadedScore> {
  const bytes = new Uint8Array(data);

  let source: ScoreSource = 'musicxml';
  let notice: string | null = null;
  let xml: string;

  if (isMidiFile(bytes)) {
    source = 'midi';
    xml = midiToMusicXml(data, filename);
  } else if (isPdfFile(bytes)) {
    source = 'pdf';
    const result = await pdfToMusicXml(data, filename);
    xml = result.xml;
    notice = describeImport(result);
  } else if (isZip(bytes)) {
    xml = await extractMxl(data);
  } else {
    xml = new TextDecoder('utf-8').decode(bytes);
  }

  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error(`Could not parse ${filename}: ${parseError.textContent?.slice(0, 200)}`);

  const rootTag = doc.documentElement?.tagName;
  if (rootTag !== 'score-partwise' && rootTag !== 'score-timewise') {
    throw new Error(`${filename} does not look like MusicXML (root element is <${rootTag}>).`);
  }

  return { xml, doc, filename, source, notice };
}

/**
 * An .mxl is a zip whose META-INF/container.xml names the real score file.
 * Fall back to the first non-META-INF .xml entry if the container is missing.
 */
async function extractMxl(data: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);

  const containerFile = zip.file('META-INF/container.xml');
  if (containerFile) {
    const containerXml = await containerFile.async('string');
    const container = new DOMParser().parseFromString(containerXml, 'application/xml');
    const path = container.querySelector('rootfile')?.getAttribute('full-path');
    const entry = path ? zip.file(path) : null;
    if (entry) return entry.async('string');
  }

  const fallback = zip
    .file(/\.(xml|musicxml)$/i)
    .find((f) => !f.name.startsWith('META-INF/') && !f.name.startsWith('__MACOSX/'));
  if (!fallback) throw new Error('No MusicXML file found inside the .mxl archive.');
  return fallback.async('string');
}
