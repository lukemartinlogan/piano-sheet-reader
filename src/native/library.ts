import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { base64ToBuffer, bufferToBase64 } from './base64';
import { isNative } from './platform';

/**
 * The on-device score library.
 *
 * There is no account, no sync and no server: a score you open is copied into
 * the app's own Documents folder and stays there. That folder is exposed to the
 * Files app (`UIFileSharingEnabled`), so the library is a real folder the user
 * can add to, rename in, and back up — not a private database they cannot see.
 */
const FOLDER = 'Scores';
const INDEX = 'library.json';
const LAST_OPENED = 'sheetreader.lastOpened';

export interface LibraryEntry {
  /** File name on disk, and the identity of the entry. */
  name: string;
  /** Title read out of the score, when it had one. */
  title: string;
  composer: string;
  size: number;
  /** Milliseconds since the epoch, from the file itself. */
  modified: number;
}

/** Titles are not derivable from a file name, so they are kept alongside. */
type TitleIndex = Record<string, { title: string; composer: string }>;

const ensureFolder = async (): Promise<void> => {
  try {
    await Filesystem.mkdir({ path: FOLDER, directory: Directory.Documents, recursive: true });
  } catch {
    // Already there. `mkdir` has no "if missing" flag, so the throw is the check.
  }
};

const readIndex = async (): Promise<TitleIndex> => {
  try {
    const { data } = await Filesystem.readFile({
      path: `${FOLDER}/${INDEX}`,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
    });
    const parsed: unknown = JSON.parse(typeof data === 'string' ? data : '{}');
    return parsed && typeof parsed === 'object' ? (parsed as TitleIndex) : {};
  } catch {
    return {};
  }
};

const writeIndex = async (index: TitleIndex): Promise<void> => {
  await Filesystem.writeFile({
    path: `${FOLDER}/${INDEX}`,
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
    data: JSON.stringify(index),
    recursive: true,
  });
};

/**
 * A file name that is safe on disk and still recognisable.
 *
 * Names arrive from Mail attachments and AirDrop as well as from the picker, so
 * they can contain anything; a `/` in particular would silently write outside
 * the library folder. Spaces and hyphens are left alone — they are most of what
 * makes a score's name readable.
 */
const safeName = (filename: string): string => {
  const cleaned = filename
    .split(/[/\\]/)
    .pop()!
    .replace(/[:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '')
    .trim();
  return cleaned.slice(-120) || 'score';
};

export async function listScores(): Promise<LibraryEntry[]> {
  if (!isNative()) return [];
  await ensureFolder();
  const index = await readIndex();
  const { files } = await Filesystem.readdir({ path: FOLDER, directory: Directory.Documents });
  return files
    .filter((file) => file.type === 'file' && file.name !== INDEX)
    .map((file) => ({
      name: file.name,
      title: index[file.name]?.title ?? '',
      composer: index[file.name]?.composer ?? '',
      size: file.size,
      modified: file.mtime,
    }))
    .sort((a, b) => b.modified - a.modified);
}

export async function readScore(name: string): Promise<ArrayBuffer> {
  const { data } = await Filesystem.readFile({
    path: `${FOLDER}/${name}`,
    directory: Directory.Documents,
  });
  if (typeof data !== 'string') throw new Error(`Could not read "${name}".`);
  return base64ToBuffer(data);
}

/**
 * File a score into the library, returning the name it was stored under.
 *
 * The name is the identity, so opening the same file again overwrites its own
 * entry rather than adding another. That is what a folder does, and it is the
 * behaviour that matters here: a score sent over from Files or Mail twice — or
 * every time you want to read it — must not grow the library each time.
 */
export async function saveScore(
  filename: string,
  data: ArrayBuffer,
  meta: { title: string; composer: string },
): Promise<string> {
  await ensureFolder();
  const name = safeName(filename);

  await Filesystem.writeFile({
    path: `${FOLDER}/${name}`,
    directory: Directory.Documents,
    data: bufferToBase64(data),
    recursive: true,
  });

  const index = await readIndex();
  index[name] = { title: meta.title, composer: meta.composer };
  await writeIndex(index);
  return name;
}

export async function deleteScore(name: string): Promise<void> {
  await Filesystem.deleteFile({ path: `${FOLDER}/${name}`, directory: Directory.Documents });
  const index = await readIndex();
  delete index[name];
  await writeIndex(index);
  if (rememberedScore() === name) rememberScore(null);
}

/**
 * The score to reopen on the next launch.
 *
 * An app closed and reopened between practice sessions should come back to the
 * piece you were reading, not to the bundled demo.
 */
export const rememberScore = (name: string | null): void => {
  try {
    if (name === null) localStorage.removeItem(LAST_OPENED);
    else localStorage.setItem(LAST_OPENED, name);
  } catch {
    // A storage failure is not worth failing an import over.
  }
};

export const rememberedScore = (): string | null => {
  try {
    return localStorage.getItem(LAST_OPENED);
  } catch {
    return null;
  }
};
