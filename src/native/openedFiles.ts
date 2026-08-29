import { App } from '@capacitor/app';
import { Filesystem } from '@capacitor/filesystem';
import { base64ToBuffer } from './base64';
import { isNative } from './platform';

/**
 * Scores handed to the app by iOS.
 *
 * "Open in Sheet Reader" from Files, Mail or AirDrop does not go through the
 * page's file input — iOS copies the file into `Documents/Inbox` and launches
 * (or foregrounds) the app with its URL. The copy is ours to clean up, so it is
 * read once and deleted; the library is where it lives after that.
 */
export interface OpenedFile {
  data: ArrayBuffer;
  filename: string;
}

const nameFromUrl = (url: string): string => {
  const last = url.split('?')[0].split('#')[0].split('/').pop() ?? 'score';
  try {
    return decodeURIComponent(last) || 'score';
  } catch {
    return last;
  }
};

const readAndConsume = async (url: string): Promise<OpenedFile> => {
  // The URL is passed through still percent-encoded: the native side parses it
  // as a URL, and decoding first breaks any path containing a space.
  const { data } = await Filesystem.readFile({ path: url });
  if (typeof data !== 'string') throw new Error('Could not read the opened file.');
  const buffer = base64ToBuffer(data);
  try {
    await Filesystem.deleteFile({ path: url });
  } catch {
    // Inbox is ours to tidy, but a file we could not delete is still a file we
    // read — better to open the score than to fail on the housekeeping.
  }
  return { data: buffer, filename: nameFromUrl(url) };
};

/**
 * Call `onFile` for every score iOS hands us, including the one that launched
 * the app. Returns a teardown.
 */
export function watchOpenedFiles(onFile: (file: OpenedFile) => void): () => void {
  if (!isNative()) return () => {};

  let disposed = false;
  /** A cold launch reports the same URL twice: once as the launch URL, once as an event. */
  const seen = new Set<string>();

  const handle = (url: string | undefined | null) => {
    if (disposed || !url || !url.startsWith('file://') || seen.has(url)) return;
    seen.add(url);
    void readAndConsume(url).then(onFile, () => seen.delete(url));
  };

  // The listener is registered after the WebView has loaded, so a file that
  // launched the app cold has already been and gone by now; that one is found
  // by asking rather than by waiting.
  void App.getLaunchUrl().then((result) => handle(result?.url));

  const listener = App.addListener('appUrlOpen', (event) => handle(event.url));

  return () => {
    disposed = true;
    void listener.then((handle) => handle.remove());
  };
}

/**
 * Whether the app was launched by a file rather than by its icon.
 *
 * The launch file and the remembered score would otherwise both load, and the
 * user would watch the wrong piece engrave first.
 */
export async function launchedWithFile(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const result = await App.getLaunchUrl();
    return Boolean(result?.url?.startsWith('file://'));
  } catch {
    return false;
  }
}
