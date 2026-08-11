export type ClefSign = 'G' | 'F' | 'C' | 'percussion' | 'TAB' | 'none';

export interface Clef {
  sign: ClefSign;
  /** Staff line the clef sits on, counted 1..5 from the bottom line. */
  line: number;
  /** MusicXML <clef-octave-change>: -1 for treble-8vb, +1 for 8va, etc. */
  octaveChange: number;
}

export const TREBLE: Clef = { sign: 'G', line: 2, octaveChange: 0 };

/** A single sounding note, with times already resolved to seconds. */
export interface PlayNote {
  midi: number;
  /** Seconds from the start of the piece. */
  start: number;
  /** Seconds. Tied notes are merged into one long note. */
  duration: number;
  measureIndex: number;
  /** 0-based staff within the whole score (treble = 0, bass = 1 for solo piano). */
  staffIndex: number;
  velocity: number;
}

/**
 * Vertical span of the notes in one measure of one staff, as *printed*.
 *
 * Values are absolute diatonic positions (C0 = 0, one step per letter), already
 * adjusted for any octave-shift bracket, so they say where a note sits on the
 * page rather than what pitch it sounds.
 */
export interface StaffExtent {
  lowest: number;
  highest: number;
}

export interface ParsedScore {
  title: string;
  composer: string;
  notes: PlayNote[];
  /** Start time of each measure, in seconds. Length === measureCount. */
  measureStarts: number[];
  measureCount: number;
  /** Total number of staves across all parts. */
  staffCount: number;
  /**
   * Clef in effect at the start of each measure, keyed `${measureIndex}:${staffIndex}`.
   * Sparse: only records changes. Use `clefAt()` to resolve.
   */
  clefChanges: Map<string, Clef>;
  /** Printed vertical span per measure/staff, keyed `${measureIndex}:${staffIndex}`. */
  staffExtents: Map<string, StaffExtent>;
  /**
   * Printed diatonic position of every notehead, keyed `${measureIndex}:${staffIndex}`.
   * One entry per drawn notehead (chord members and tie continuations included),
   * so it can be matched one-to-one against what the renderer put on the page.
   */
  printedPositions: Map<string, number[]>;
  totalDuration: number;
}

/** Printed span of a measure, or null when it holds no notes (rests only). */
export function extentAt(
  score: ParsedScore,
  measureIndex: number,
  staffIndex: number,
): StaffExtent | null {
  return score.staffExtents.get(`${measureIndex}:${staffIndex}`) ?? null;
}

/** Resolve the clef in effect for a given measure/staff, walking back to the last change. */
export function clefAt(score: ParsedScore, measureIndex: number, staffIndex: number): Clef {
  for (let m = measureIndex; m >= 0; m--) {
    const found = score.clefChanges.get(`${m}:${staffIndex}`);
    if (found) return found;
  }
  return TREBLE;
}
