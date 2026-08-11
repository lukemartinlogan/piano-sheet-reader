import JSZip from 'jszip';

export interface LoadedScore {
  /** Raw MusicXML text, ready for both OSMD and our own parser. */
  xml: string;
  doc: Document;
  filename: string;
}

const isZip = (bytes: Uint8Array): boolean =>
  bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);

/** Read a .musicxml/.xml file, or unwrap a compressed .mxl container. */
export async function loadMusicXml(data: ArrayBuffer, filename: string): Promise<LoadedScore> {
  const bytes = new Uint8Array(data);
  const xml = isZip(bytes) ? await extractMxl(data) : new TextDecoder('utf-8').decode(bytes);

  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error(`Could not parse ${filename}: ${parseError.textContent?.slice(0, 200)}`);

  const rootTag = doc.documentElement?.tagName;
  if (rootTag !== 'score-partwise' && rootTag !== 'score-timewise') {
    throw new Error(`${filename} does not look like MusicXML (root element is <${rootTag}>).`);
  }

  return { xml, doc, filename };
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
