/**
 * Client for the shared sheet library on the server.
 *
 * There is no backend service: the library is nginx's WebDAV module over a
 * directory, on the same origin as the app (see the deployment's
 * nginx-default.conf). There is a single implicit user, so every request,
 * reads and writes alike, is unauthenticated.
 */

export interface LibraryEntry {
  name: string;
  /** Bytes, as reported by the autoindex listing. */
  size: number;
  /** Last-modified, RFC 1123 as nginx emits it. */
  mtime: string;
}

const BASE = '/library/';
/**
 * The library needs an HTTP origin. Capacitor serves the built bundle from
 * file://, where there is no server to talk to.
 */
export const libraryAvailable = (): boolean =>
  typeof window !== 'undefined' && window.location.protocol.startsWith('http');

/**
 * Filenames become URL path segments and must not carry directory structure,
 * so flatten anything the OS handed us and keep the extension readable.
 */
export function libraryName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(/[^\w.@ ()+-]/g, '_').slice(0, 180) || 'sheet';
}

export async function listLibrary(): Promise<LibraryEntry[]> {
  const response = await fetch(BASE, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Could not list the library (${response.status}).`);
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is { name: string; type?: string; size?: number; mtime?: string } =>
      typeof e === 'object' && e !== null && typeof (e as { name?: unknown }).name === 'string')
    .filter((e) => e.type !== 'directory')
    .map((e) => ({ name: e.name, size: e.size ?? 0, mtime: e.mtime ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Upload a sheet, overwriting any file of the same name. */
export async function uploadToLibrary(file: File, name = libraryName(file.name)): Promise<void> {
  const response = await fetch(BASE + encodeURIComponent(name), {
    method: 'PUT',
    body: file,
  });
  if (!response.ok) throw new Error(`Upload failed (${response.status}).`);
}

export async function deleteFromLibrary(name: string): Promise<void> {
  const response = await fetch(BASE + encodeURIComponent(name), { method: 'DELETE' });
  // 404 means it is already gone, which is the state the caller wanted.
  if (!response.ok && response.status !== 404) {
    throw new Error(`Delete failed (${response.status}).`);
  }
}

/** Fetch a stored sheet as a File, so it can go through the normal open path. */
export async function fileFromLibrary(name: string): Promise<File> {
  const response = await fetch(BASE + encodeURIComponent(name));
  if (!response.ok) throw new Error(`Could not download ${name} (${response.status}).`);
  return new File([await response.blob()], name);
}
