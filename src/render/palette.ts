/**
 * One colour per note letter.
 *
 * A colour means the same thing everywhere it appears: C is red on the treble
 * staff and red on the bass staff, on a line or in a space, in any octave. Seven
 * hues spread around the wheel so no two neighbours are easy to confuse. Each
 * comes in two weights because a letter has to read against two very different
 * backgrounds: `ink` is dark, for text on the white page or in the white hole of
 * a half note; `onDark` is bright, for text sitting on a solid black notehead.
 */
export interface LetterColor {
  /** Dark: for a letter on a light background. */
  ink: string;
  /** Bright: for a letter on a solid black notehead. */
  onDark: string;
  /** Near-solid pastel, for the row band behind the staff. */
  band: string;
}

export const LETTER_COLORS: Record<string, LetterColor> = {
  C: { ink: '#b71c1c', onDark: '#ff7b7b', band: 'rgba(250, 200, 200, 0.9)' },
  D: { ink: '#d84315', onDark: '#ffab5e', band: 'rgba(252, 216, 186, 0.9)' },
  E: { ink: '#7a5b06', onDark: '#ffd84d', band: 'rgba(246, 233, 176, 0.9)' },
  F: { ink: '#1b5e20', onDark: '#71e07f', band: 'rgba(197, 231, 197, 0.9)' },
  G: { ink: '#00695c', onDark: '#4ddbe0', band: 'rgba(184, 227, 223, 0.9)' },
  A: { ink: '#0d47a1', onDark: '#7fc4ff', band: 'rgba(197, 218, 246, 0.9)' },
  B: { ink: '#6a1b9a', onDark: '#e08cff', band: 'rgba(226, 205, 240, 0.9)' },
};

const FALLBACK: LetterColor = {
  ink: '#263238',
  onDark: '#e0e4e6',
  band: 'rgba(224, 228, 230, 0.9)',
};

export const colorFor = (letter: string): LetterColor => LETTER_COLORS[letter] ?? FALLBACK;
