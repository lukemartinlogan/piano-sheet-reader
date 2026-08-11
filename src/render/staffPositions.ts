import type { Clef } from '../score/types';

const LETTERS = 'CDEFGAB';

/**
 * Absolute diatonic number of the bottom staff line for a clef, counting
 * C0 = 0 with one step per letter.
 *
 * Shared by the margin guide and the in-notehead letters so the two can never
 * disagree about what a staff position is called.
 */
export function bottomLineDiatonic(clef: Clef): number {
  // The pitch each clef sign designates.
  const reference: Record<string, number> = {
    G: 4 * 7 + 4, // G4
    F: 3 * 7 + 3, // F3
    C: 4 * 7 + 0, // C4
  };
  const ref = reference[clef.sign] ?? reference.G;
  // Consecutive staff lines are two diatonic steps apart.
  return ref - 2 * (clef.line - 1) + 7 * clef.octaveChange;
}

export const letterForDiatonic = (diatonic: number): string =>
  LETTERS[((diatonic % 7) + 7) % 7];

export const octaveForDiatonic = (diatonic: number): number => Math.floor(diatonic / 7);
