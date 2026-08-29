import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { ParsedScore, PlayNote } from '../score/types';
import type { Player } from '../audio/Player';
import { colorFor } from '../render/palette';
import {
  keyRangeFor,
  keyboardLayout,
  letterForKey,
  octaveForKey,
  type KeyboardLayout,
} from '../render/keyboard';

export interface PianoRollProps {
  score: ParsedScore | null;
  player: Player;
  /** The roll only animates while it is the visible mode. */
  active: boolean;
  colorByLetter: boolean;
  showLetters: boolean;
  /** How far ahead the falling notes reach, in seconds. */
  fallSeconds: number;
  mutedStaves: number[];
}

const BACKDROP = '#0f1116';
const BLACK_LANE = 'rgba(255, 255, 255, 0.035)';
const OCTAVE_LINE = 'rgba(255, 255, 255, 0.09)';
const MEASURE_LINE = 'rgba(255, 255, 255, 0.13)';
const MEASURE_TEXT = 'rgba(232, 234, 240, 0.4)';
const STRIKE_LINE = '#ffd54a';
const WHITE_KEY = '#eceae4';
const WHITE_KEY_EDGE = '#1a1c22';
const BLACK_KEY = '#20232c';
/** Right hand, then left, when notes are not coloured by letter. */
const HAND_COLORS = ['#5aa9ff', '#ffb066'];

/** A tapped key stays lit this long, so a click reads as a keypress. */
const TAP_MS = 260;

export function PianoRoll({
  score,
  player,
  active,
  colorByLetter,
  showLetters,
  fallSeconds,
  mutedStaves,
}: PianoRollProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  /** midi -> time (ms) the manual tap should stop being drawn. */
  const tapsRef = useRef(new Map<number, number>());
  /** The in-flight drag-scrub, when one finger is dragging the roll. */
  const scrubRef = useRef<{ pointerId: number; lastY: number; secondsPerPixel: number } | null>(null);

  // Notes sorted for the window search, plus the pitch span to draw.
  const prepared = useMemo(() => {
    const notes = [...(score?.notes ?? [])].sort((a, b) => a.start - b.start);
    const longest = notes.reduce((max, note) => Math.max(max, note.duration), 0);
    const { low, high } = keyRangeFor(notes.map((note) => note.midi));
    return { notes, longest, low, high };
  }, [score]);

  // The draw loop reads settings through a ref so changing one does not restart it.
  const settingsRef = useRef({ colorByLetter, showLetters, fallSeconds, mutedStaves, score });
  settingsRef.current = { colorByLetter, showLetters, fallSeconds, mutedStaves, score };
  const preparedRef = useRef(prepared);
  preparedRef.current = prepared;
  /** Forces a repaint when a setting changes while playback is parked. */
  const dirtyRef = useRef(true);
  useEffect(() => {
    dirtyRef.current = true;
  }, [colorByLetter, showLetters, fallSeconds, mutedStaves, prepared, active]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      sizeRef.current = { width: container.clientWidth, height: container.clientHeight };
    });
    observer.observe(container);
    sizeRef.current = { width: container.clientWidth, height: container.clientHeight };
    return () => observer.disconnect();
  }, []);

  // Wheel scrubs through the piece: the roll is a timeline, so it should scroll.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const seconds = (event.deltaY / 320) * settingsRef.current.fallSeconds;
      player.seek(player.position - seconds);
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [active, player]);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let frame = 0;
    let lastPosition = Number.NaN;
    let lastWidth = 0;
    let lastHeight = 0;
    let lastKeysDown = -1;

    const render = () => {
      frame = requestAnimationFrame(render);

      const { width, height } = sizeRef.current;
      if (width < 2 || height < 2) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const resized = width !== lastWidth || height !== lastHeight;
      if (resized) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        lastWidth = width;
        lastHeight = height;
      }

      const position = player.position;
      const taps = tapsRef.current;
      const now = performance.now();
      for (const [midi, until] of taps) if (until <= now) taps.delete(midi);
      // Idle and unchanged: nothing to repaint.
      const idle =
        !resized && !dirtyRef.current && position === lastPosition && taps.size === 0 && !player.state.playing;
      if (idle) return;
      dirtyRef.current = false;
      lastPosition = position;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const keysDown = paint(ctx, width, height, position, {
        ...settingsRef.current,
        prepared: preparedRef.current,
        taps,
      });
      if (keysDown !== lastKeysDown) {
        container.dataset.keysDown = String(keysDown);
        lastKeysDown = keysDown;
      }
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [active, player]);

  // Expose the drawn range so the render check can assert against it.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.dataset.lowKey = String(prepared.low);
    container.dataset.highKey = String(prepared.high);
  }, [prepared]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const { width, height } = sizeRef.current;
    if (width < 2) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const layout = keyboardLayout(prepared.low, prepared.high, width);
    const keyboardHeight = keyboardHeightFor(layout, height);
    const strike = height - keyboardHeight;
    if (y < strike) {
      // Above the keys the roll *is* the timeline, so it is dragged rather than
      // scrolled — there is no wheel on an iPad. The roll follows the finger:
      // a note under it stays under it, which means dragging down runs time
      // forward, since that is the direction the notes fall.
      scrubRef.current = {
        pointerId: event.pointerId,
        lastY: event.clientY,
        // Feels like grabbing the roll only if a pixel is worth the same amount
        // of time going down as the notes travel coming up.
        secondsPerPixel: settingsRef.current.fallSeconds / Math.max(1, strike),
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      player.pause();
      return;
    }

    // Black keys are short: below their tips, the white key underneath wins.
    const blackDepth = keyboardHeight * 0.62;
    const overBlack = y - (height - keyboardHeight) <= blackDepth;
    const key = layout.hitTest(x);
    const hit = key && (overBlack || !key.black) ? key : layout.keys.find(
      (candidate) => !candidate.black && x >= candidate.x && x < candidate.x + candidate.width,
    );
    if (!hit) return;
    player.preview(hit.midi);
    tapsRef.current.set(hit.midi, performance.now() + TAP_MS);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const scrub = scrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    const delta = event.clientY - scrub.lastY;
    scrub.lastY = event.clientY;
    player.seek(player.position + delta * scrub.secondsPerPixel);
  };

  const endScrub = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const scrub = scrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    scrubRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="piano-roll" ref={containerRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
      />
      {!score && (
        <p className="piano-roll-empty">Open a score to see it fall.</p>
      )}
    </div>
  );
}

const keyboardHeightFor = (layout: KeyboardLayout, height: number): number =>
  Math.max(52, Math.min(layout.whiteWidth * 4.2, height * 0.36, 170));

interface PaintState {
  colorByLetter: boolean;
  showLetters: boolean;
  fallSeconds: number;
  mutedStaves: number[];
  score: ParsedScore | null;
  prepared: { notes: PlayNote[]; longest: number; low: number; high: number };
  taps: Map<number, number>;
}

/** Draw one frame. Returns how many keys are held, for the render check. */
function paint(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  position: number,
  state: PaintState,
): number {
  const { prepared, fallSeconds } = state;
  const layout = keyboardLayout(prepared.low, prepared.high, width);
  const keyboardHeight = keyboardHeightFor(layout, height);
  const strike = height - keyboardHeight;
  const muted = new Set(state.mutedStaves);

  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, width, height);

  // Lanes: a black key's column is shaded so pitch can be read off the roll
  // itself, without tracing every note down to the keyboard.
  ctx.fillStyle = BLACK_LANE;
  for (const key of layout.keys) {
    if (key.black) ctx.fillRect(key.x, 0, key.width, strike);
  }
  ctx.strokeStyle = OCTAVE_LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const key of layout.keys) {
    if (key.black || key.midi % 12 !== 0) continue;
    ctx.moveTo(Math.round(key.x) + 0.5, 0);
    ctx.lineTo(Math.round(key.x) + 0.5, strike);
  }
  ctx.stroke();

  const yAt = (seconds: number) => strike - ((seconds - position) / fallSeconds) * strike;

  // Bar lines give the falling notes a pulse to be read against.
  const starts = state.score?.measureStarts ?? [];
  ctx.strokeStyle = MEASURE_LINE;
  ctx.fillStyle = MEASURE_TEXT;
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.beginPath();
  for (let index = 0; index < starts.length; index++) {
    const y = yAt(starts[index]);
    if (y < -20) break;
    if (y > strike) continue;
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(width, Math.round(y) + 0.5);
    if (keyboardHeight > 60) ctx.fillText(String(index + 1), 4, y - 2);
  }
  ctx.stroke();

  // Falling notes, plus the set of keys currently sounding.
  const held = new Map<number, string>();
  const notes = prepared.notes;
  let index = firstNoteIndex(notes, position - prepared.longest - 0.001);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (; index < notes.length; index++) {
    const note = notes[index];
    if (note.start > position + fallSeconds) break;

    const key = layout.keyAt(note.midi);
    if (!key) continue;
    const top = yAt(note.start + note.duration);
    if (top >= strike) continue;
    const bottom = Math.min(strike, yAt(note.start));
    if (bottom <= 0) continue;

    const color = state.colorByLetter
      ? colorFor(letterForKey(note.midi)).onDark
      : HAND_COLORS[note.staffIndex] ?? HAND_COLORS[0];
    const dimmed = muted.has(note.staffIndex);

    const x = key.x + 1;
    const w = Math.max(2, key.width - 2);
    const h = Math.max(3, bottom - top);
    ctx.globalAlpha = dimmed ? 0.25 : 1;
    ctx.fillStyle = color;
    roundRect(ctx, x, top, w, h, Math.min(4, w / 2));
    ctx.fill();
    // A brighter cap makes the leading edge — the moment of the strike — clear.
    ctx.globalAlpha = dimmed ? 0.3 : 0.85;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(x, bottom - 2, w, 2);
    ctx.globalAlpha = 1;

    if (state.showLetters && h >= 17 && w >= 13) {
      ctx.fillStyle = 'rgba(10, 11, 15, 0.82)';
      ctx.font = `600 ${Math.min(13, w * 0.8)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.fillText(letterForKey(note.midi), x + w / 2, bottom - 9);
    }

    if (!dimmed && note.start <= position && position < note.start + note.duration) {
      held.set(note.midi, color);
    }
  }

  for (const midi of state.taps.keys()) {
    if (!held.has(midi)) held.set(midi, STRIKE_LINE);
  }

  drawKeyboard(ctx, layout, width, strike, keyboardHeight, held);

  // The strike line last, so nothing is drawn over the moment of contact.
  ctx.fillStyle = STRIKE_LINE;
  ctx.fillRect(0, strike - 1, width, 2);

  return held.size;
}

function drawKeyboard(
  ctx: CanvasRenderingContext2D,
  layout: KeyboardLayout,
  width: number,
  top: number,
  height: number,
  held: Map<number, string>,
): void {
  const blackHeight = height * 0.62;

  ctx.fillStyle = WHITE_KEY;
  ctx.fillRect(0, top, width, height);

  for (const key of layout.keys) {
    if (key.black) continue;
    const down = held.get(key.midi);
    if (down) {
      ctx.fillStyle = down;
      ctx.fillRect(key.x, top, key.width, height);
    }
    ctx.strokeStyle = WHITE_KEY_EDGE;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(Math.round(key.x) + 0.5, top);
    ctx.lineTo(Math.round(key.x) + 0.5, top + height);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  for (const key of layout.keys) {
    if (!key.black) continue;
    const down = held.get(key.midi);
    ctx.fillStyle = down ?? BLACK_KEY;
    roundRect(ctx, key.x, top, key.width, blackHeight, 2);
    ctx.fill();
  }

  // Key names, once there is room for them to be legible.
  if (layout.whiteWidth >= 13) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${Math.min(12, layout.whiteWidth * 0.62)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    for (const key of layout.keys) {
      if (key.black) continue;
      const isC = key.midi % 12 === 0;
      if (!isC && layout.whiteWidth < 17) continue;
      ctx.fillStyle = held.has(key.midi) ? 'rgba(10, 11, 15, 0.85)' : isC ? '#5c6270' : '#9aa0ae';
      const label = isC ? `C${octaveForKey(key.midi)}` : letterForKey(key.midi);
      ctx.fillText(label, key.x + key.width / 2, top + height - 7);
    }
  }

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, top + 0.5);
  ctx.lineTo(width, top + 0.5);
  ctx.stroke();
}

/** First note that could still be sounding or falling at `seconds`. */
function firstNoteIndex(notes: PlayNote[], seconds: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].start < seconds) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, radius);
  } else {
    ctx.rect(x, y, width, height);
  }
}
