/**
 * Base64 either way, because the native file bridge speaks base64 and the
 * importers speak `ArrayBuffer`.
 *
 * Both directions go in chunks. `String.fromCharCode(...bytes)` on a whole file
 * spreads one argument per byte, and a multi-megabyte PDF overflows the call
 * stack long before it overflows memory.
 */
const CHUNK = 0x8000;

export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBuffer(base64: string): ArrayBuffer {
  // A data URL is what the bridge hands back for some reads; keep only the payload.
  const comma = base64.indexOf(',');
  const payload = base64.startsWith('data:') && comma >= 0 ? base64.slice(comma + 1) : base64;
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}
