import type { Clef, ClefSign, ParsedScore, PlayNote, StaffExtent } from './types';

const STEP_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** Diatonic index of each letter within an octave, C = 0. */
const STEP_DIATONIC: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const DEFAULT_BPM = 100;

/** One note as read from the file, with time still expressed in quarter notes. */
interface RawNote {
  midi: number;
  measureIndex: number;
  /** Quarter notes from the start of the piece. */
  qStart: number;
  qEnd: number;
  staffIndex: number;
  voiceKey: string;
  tieStart: boolean;
  tieStop: boolean;
}

interface TempoEvent {
  q: number;
  bpm: number;
}

const text = (el: Element | null | undefined): string => el?.textContent?.trim() ?? '';
const num = (el: Element | null | undefined, fallback = 0): number => {
  const v = parseFloat(text(el));
  return Number.isFinite(v) ? v : fallback;
};
const child = (el: Element, tag: string): Element | null => {
  for (const c of Array.from(el.children)) if (c.tagName === tag) return c;
  return null;
};

/**
 * Parse a MusicXML document into a flat, time-resolved note list plus the
 * per-measure clef map that the letter gutter needs.
 *
 * Deliberate simplifications: repeats/codas are not expanded (the score plays
 * straight through), and grace notes are skipped since they carry no duration.
 */
export function parseScore(doc: Document): ParsedScore {
  const root = doc.documentElement;
  if (root.tagName === 'score-timewise') {
    throw new Error('score-timewise MusicXML is not supported. Please export as score-partwise.');
  }

  const parts = Array.from(root.getElementsByTagName('part'));
  if (parts.length === 0) throw new Error('No <part> found in this MusicXML file.');

  const rawNotes: RawNote[] = [];
  const clefChanges = new Map<string, Clef>();
  const staffExtents = new Map<string, StaffExtent>();
  const printedPositions = new Map<string, number[]>();
  /** Length of each measure in quarter notes, taken as the max across parts. */
  const measureLengthQ: number[] = [];
  /** Tempo marks keyed by (measureIndex, quarter offset within the measure). */
  const rawTempos: { measureIndex: number; qOffset: number; bpm: number }[] = [];

  let staffOffset = 0;
  let measureCount = 0;

  for (const part of parts) {
    const measures = Array.from(part.children).filter((c) => c.tagName === 'measure');
    measureCount = Math.max(measureCount, measures.length);

    let divisions = 1;
    let stavesInPart = 1;
    // Fallback measure length when a measure contains no timed content at all.
    let timeSigQ = 4;
    /**
     * Active octave-shift bracket per staff, in diatonic steps, spanning
     * measures until its "stop". MusicXML gives sounding pitch, so this is what
     * turns it back into the position actually printed on the staff.
     */
    const octaveShift = new Map<number, number>();

    measures.forEach((measure, measureIndex) => {
      let cursorQ = 0;
      let maxQ = 0;
      let lastStartQ = 0;

      for (const node of Array.from(measure.children)) {
        switch (node.tagName) {
          case 'attributes': {
            const div = child(node, 'divisions');
            if (div) divisions = num(div, divisions) || divisions;

            const staves = child(node, 'staves');
            if (staves) stavesInPart = Math.max(1, num(staves, 1));

            const time = child(node, 'time');
            if (time) {
              const beats = num(child(time, 'beats'), 4);
              const beatType = num(child(time, 'beat-type'), 4);
              if (beats > 0 && beatType > 0) timeSigQ = (beats * 4) / beatType;
            }

            for (const clefEl of Array.from(node.children).filter((c) => c.tagName === 'clef')) {
              const staffNum = parseInt(clefEl.getAttribute('number') ?? '1', 10) || 1;
              const clef: Clef = {
                sign: (text(child(clefEl, 'sign')) || 'G') as ClefSign,
                line: num(child(clefEl, 'line'), defaultLineFor(text(child(clefEl, 'sign')))),
                octaveChange: num(child(clefEl, 'clef-octave-change'), 0),
              };
              clefChanges.set(`${measureIndex}:${staffOffset + staffNum - 1}`, clef);
            }
            break;
          }

          case 'sound': {
            const bpm = parseFloat(node.getAttribute('tempo') ?? '');
            if (Number.isFinite(bpm) && bpm > 0) rawTempos.push({ measureIndex, qOffset: cursorQ, bpm });
            break;
          }

          case 'direction': {
            // <sound tempo> lives inside <direction>, possibly nested in <direction-type>.
            for (const sound of Array.from(node.getElementsByTagName('sound'))) {
              const bpm = parseFloat(sound.getAttribute('tempo') ?? '');
              if (Number.isFinite(bpm) && bpm > 0) rawTempos.push({ measureIndex, qOffset: cursorQ, bpm });
            }

            for (const shift of Array.from(node.getElementsByTagName('octave-shift'))) {
              const staffNum = num(child(node, 'staff'), 1) || 1;
              const type = shift.getAttribute('type') ?? '';
              if (type === 'stop') {
                octaveShift.delete(staffNum);
                continue;
              }
              // size 8 shifts by one octave (7 diatonic steps), size 15 by two.
              const steps = (parseInt(shift.getAttribute('size') ?? '8', 10) || 8) - 1;
              // "up" means the print is shifted up from the true pitch (an 8vb
              // bracket); "down" is the 8va case.
              if (type === 'up') octaveShift.set(staffNum, steps);
              else if (type === 'down') octaveShift.set(staffNum, -steps);
            }
            break;
          }

          case 'backup': {
            cursorQ -= num(child(node, 'duration'), 0) / divisions;
            break;
          }

          case 'forward': {
            cursorQ += num(child(node, 'duration'), 0) / divisions;
            maxQ = Math.max(maxQ, cursorQ);
            break;
          }

          case 'note': {
            // Grace notes have no <duration>; they never move the cursor.
            if (child(node, 'grace')) break;

            const durQ = num(child(node, 'duration'), 0) / divisions;
            const isChord = !!child(node, 'chord');
            const startQ = isChord ? lastStartQ : cursorQ;

            if (!isChord) {
              lastStartQ = cursorQ;
              cursorQ += durQ;
              maxQ = Math.max(maxQ, cursorQ);
            }

            const pitch = child(node, 'pitch');
            if (!pitch) break; // a rest

            const step = text(child(pitch, 'step')).toUpperCase();
            const semitone = STEP_SEMITONES[step];
            if (semitone === undefined) break;
            const octave = num(child(pitch, 'octave'), 4);
            const alter = num(child(pitch, 'alter'), 0);
            const midi = (octave + 1) * 12 + semitone + alter;

            const staffNum = num(child(node, 'staff'), 1) || 1;
            const staffIndex = staffOffset + staffNum - 1;
            const ties = Array.from(node.children).filter((c) => c.tagName === 'tie');

            // Where the note is printed, which is what the letter guide labels.
            const printed =
              octave * 7 + STEP_DIATONIC[step] + (octaveShift.get(staffNum) ?? 0);
            const extentKey = `${measureIndex}:${staffIndex}`;
            const seen = printedPositions.get(extentKey);
            if (seen) seen.push(printed);
            else printedPositions.set(extentKey, [printed]);

            const extent = staffExtents.get(extentKey);
            if (!extent) {
              staffExtents.set(extentKey, { lowest: printed, highest: printed });
            } else {
              if (printed < extent.lowest) extent.lowest = printed;
              if (printed > extent.highest) extent.highest = printed;
            }

            rawNotes.push({
              midi: Math.round(midi),
              measureIndex,
              qStart: startQ,
              qEnd: startQ + durQ,
              staffIndex,
              voiceKey: text(child(node, 'voice')) || '1',
              tieStart: ties.some((t) => t.getAttribute('type') === 'start'),
              tieStop: ties.some((t) => t.getAttribute('type') === 'stop'),
            });
            break;
          }
        }
      }

      const observed = maxQ > 0 ? maxQ : timeSigQ;
      measureLengthQ[measureIndex] = Math.max(measureLengthQ[measureIndex] ?? 0, observed);
    });

    staffOffset += stavesInPart;
  }

  // Absolute quarter-note position where each measure begins.
  const measureStartQ: number[] = [];
  let acc = 0;
  for (let m = 0; m < measureCount; m++) {
    measureStartQ[m] = acc;
    acc += measureLengthQ[m] ?? 4;
  }
  const totalQ = acc;

  const timeMap = buildTimeMap(
    rawTempos.map((t) => ({ q: (measureStartQ[t.measureIndex] ?? 0) + t.qOffset, bpm: t.bpm })),
  );

  const notes = resolveTies(rawNotes, measureStartQ, timeMap);
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);

  return {
    title: text(root.querySelector('work > work-title')) || text(root.querySelector('movement-title')) || 'Untitled',
    composer: text(root.querySelector('identification > creator[type="composer"]')) || '',
    notes,
    measureStarts: measureStartQ.map((q) => timeMap(q)),
    measureCount,
    staffCount: Math.max(1, staffOffset),
    clefChanges,
    staffExtents,
    printedPositions,
    totalDuration: timeMap(totalQ),
  };
}

/** MusicXML lets <line> be omitted; these are the conventional defaults. */
function defaultLineFor(sign: string): number {
  if (sign === 'F') return 4;
  if (sign === 'C') return 3;
  return 2;
}

/**
 * Build a quarter-position -> seconds function that integrates across tempo changes,
 * so a note held through a rallentando still gets the right duration.
 */
function buildTimeMap(events: TempoEvent[]): (q: number) => number {
  const sorted = [...events].sort((a, b) => a.q - b.q).filter((e) => e.bpm > 0);
  if (sorted.length === 0 || sorted[0].q > 0) {
    sorted.unshift({ q: 0, bpm: sorted[0]?.bpm ?? DEFAULT_BPM });
  }

  // Collapse duplicate positions, keeping the last mark at each spot.
  const segments: { q: number; bpm: number; seconds: number }[] = [];
  for (const e of sorted) {
    if (segments.length > 0 && segments[segments.length - 1].q === e.q) {
      segments[segments.length - 1].bpm = e.bpm;
    } else {
      segments.push({ q: e.q, bpm: e.bpm, seconds: 0 });
    }
  }

  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    segments[i].seconds = prev.seconds + ((segments[i].q - prev.q) * 60) / prev.bpm;
  }

  return (q: number) => {
    if (q <= 0) return 0;
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (segments[mid].q <= q) lo = mid;
      else hi = mid - 1;
    }
    const seg = segments[lo];
    return seg.seconds + ((q - seg.q) * 60) / seg.bpm;
  };
}

/** Merge tied notes into single sustained notes and convert to seconds. */
function resolveTies(
  raw: RawNote[],
  measureStartQ: number[],
  timeMap: (q: number) => number,
): PlayNote[] {
  const ordered = [...raw].sort(
    (a, b) => a.measureIndex - b.measureIndex || a.qStart - b.qStart || a.midi - b.midi,
  );

  const open = new Map<string, PlayNote>();
  const out: PlayNote[] = [];

  for (const rn of ordered) {
    const base = measureStartQ[rn.measureIndex] ?? 0;
    const startSec = timeMap(base + rn.qStart);
    const endSec = timeMap(base + rn.qEnd);
    const key = `${rn.staffIndex}:${rn.voiceKey}:${rn.midi}`;
    const pending = open.get(key);

    if (rn.tieStop && pending) {
      pending.duration = Math.max(pending.duration, endSec - pending.start);
      if (!rn.tieStart) open.delete(key);
      continue;
    }

    const note: PlayNote = {
      midi: rn.midi,
      start: startSec,
      duration: Math.max(0.02, endSec - startSec),
      measureIndex: rn.measureIndex,
      staffIndex: rn.staffIndex,
      velocity: 0.75,
    };
    out.push(note);
    if (rn.tieStart) open.set(key, note);
  }

  return out;
}
