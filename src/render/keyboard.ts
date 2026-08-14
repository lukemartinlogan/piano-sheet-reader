/**
 * Piano key geometry.
 *
 * The keyboard view and the notes falling onto it have to agree on exactly
 * where every key is, so the layout is computed once here and shared. Black
 * keys are centred on the seam between their neighbours, which is close enough
 * to a real keyboard to read as one and avoids per-key offset tables.
 */

/** A0 and C8: the ends of a full-size piano. */
export const LOWEST_KEY = 21;
export const HIGHEST_KEY = 108;

const BLACK_CLASSES = new Set([1, 3, 6, 8, 10]);
const LETTERS = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];

export const isBlackKey = (midi: number): boolean => BLACK_CLASSES.has(((midi % 12) + 12) % 12);

/**
 * Letter a key is named by. A black key takes the letter of the white key it
 * sits above, which is where a reader's eye goes to find it anyway.
 */
export const letterForKey = (midi: number): string => LETTERS[((midi % 12) + 12) % 12];

export const octaveForKey = (midi: number): number => Math.floor(midi / 12) - 1;

export interface PianoKey {
  midi: number;
  black: boolean;
  /** Left edge, in pixels from the left of the keyboard. */
  x: number;
  width: number;
}

export interface KeyboardLayout {
  keys: PianoKey[];
  low: number;
  high: number;
  whiteWidth: number;
  blackWidth: number;
  keyAt: (midi: number) => PianoKey | undefined;
  /** Key under a horizontal position; black keys win, as they sit on top. */
  hitTest: (x: number) => PianoKey | undefined;
}

/**
 * Choose the span of keys to show.
 *
 * Drawing all 88 for a piece that lives in two octaves leaves every key too
 * narrow to aim at, so the range is fitted to the music and then rounded out to
 * whole octaves so the pattern of black keys still starts where the eye expects.
 */
export function keyRangeFor(midis: number[]): { low: number; high: number } {
  if (midis.length === 0) return { low: 36, high: 84 };
  let min = Infinity;
  let max = -Infinity;
  for (const midi of midis) {
    if (midi < min) min = midi;
    if (midi > max) max = midi;
  }
  let low = Math.floor(min / 12) * 12;
  let high = Math.ceil((max + 1) / 12) * 12 - 1;
  // Two octaves is the least that still reads as a keyboard.
  while (high - low < 24) {
    if (low > LOWEST_KEY) low -= 12;
    else high += 12;
  }
  return {
    low: Math.max(LOWEST_KEY, low),
    high: Math.min(HIGHEST_KEY, Math.max(high, low + 24)),
  };
}

export function keyboardLayout(low: number, high: number, width: number): KeyboardLayout {
  let whiteCount = 0;
  for (let midi = low; midi <= high; midi++) if (!isBlackKey(midi)) whiteCount++;

  const whiteWidth = width / Math.max(1, whiteCount);
  const blackWidth = whiteWidth * 0.62;

  const keys: PianoKey[] = [];
  let whiteIndex = 0;
  for (let midi = low; midi <= high; midi++) {
    if (isBlackKey(midi)) {
      // whiteIndex is now the index of the white key *above*, so its left edge
      // is the seam this black key straddles.
      keys.push({ midi, black: true, x: whiteIndex * whiteWidth - blackWidth / 2, width: blackWidth });
    } else {
      keys.push({ midi, black: false, x: whiteIndex * whiteWidth, width: whiteWidth });
      whiteIndex++;
    }
  }

  const byMidi = new Map(keys.map((key) => [key.midi, key]));
  const blacks = keys.filter((key) => key.black);
  const whites = keys.filter((key) => !key.black);

  return {
    keys,
    low,
    high,
    whiteWidth,
    blackWidth,
    keyAt: (midi) => byMidi.get(midi),
    hitTest: (x) =>
      blacks.find((key) => x >= key.x && x < key.x + key.width) ??
      whites.find((key) => x >= key.x && x < key.x + key.width),
  };
}
