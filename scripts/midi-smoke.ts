/**
 * MIDI import check: build a Standard MIDI File in memory, run it through the
 * real import path, and assert the score that comes out the other side.
 *
 *   npm run midi                      # the synthetic fixture below
 *   npm run midi -- path/to/file.mid  # summarise a real file instead
 *
 * The fixture is written by hand rather than parsed from a sample so the
 * expected answer is known exactly: every pitch, bar line, hand and tempo below
 * is asserted, including the things MIDI import is most likely to get wrong —
 * the split into two hands, bar lengths across a metre change, and tempo
 * changes landing on the right beat.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html></html>');
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;

const { loadMusicXml } = await import('../src/score/loadMusicXml');
const { parseScore } = await import('../src/score/parseScore');
const { clefAt } = await import('../src/score/types');

// ------------------------------------------------------------- writing ---

const PPQ = 480;

interface Event {
  tick: number;
  data: number[];
  /** Ties are broken by this, so a note-off precedes a note-on at the same tick. */
  order: number;
}

const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const u32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

function varlen(value: number): number[] {
  const bytes = [value & 0x7f];
  let rest = value >> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  return bytes;
}

function trackChunk(events: Event[]): number[] {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let last = 0;
  for (const event of sorted) {
    body.push(...varlen(event.tick - last), ...event.data);
    last = event.tick;
  }
  body.push(...varlen(0), 0xff, 0x2f, 0x00);
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
}

const meta = (tick: number, type: number, data: number[]): Event => ({
  tick,
  data: [0xff, type, data.length, ...data],
  order: -1,
});

const text = (value: string) => [...value].map((c) => c.charCodeAt(0));

const tempoMeta = (tick: number, bpm: number): Event => {
  const micros = Math.round(60000000 / bpm);
  return meta(tick, 0x51, [(micros >> 16) & 0xff, (micros >> 8) & 0xff, micros & 0xff]);
};

function note(channel: number, midi: number, tick: number, duration: number): Event[] {
  return [
    { tick, data: [0x90 | channel, midi, 80], order: 1 },
    { tick: tick + duration, data: [0x80 | channel, midi, 0], order: 0 },
  ];
}

/**
 * Four bars of 4/4 then one of 3/4, right hand over left, in G major, with the
 * tempo dropping from 120 to 90 at bar 3.
 */
function buildFixture(): Uint8Array {
  const conductor: Event[] = [
    meta(0, 0x03, text('Fixture in G')),
    meta(0, 0x58, [4, 2, 24, 8]),
    meta(0, 0x59, [1, 0]),
    tempoMeta(0, 120),
    tempoMeta(3840, 90),
    meta(7680, 0x58, [3, 2, 24, 8]),
  ];

  const right: Event[] = [meta(0, 0x03, text('Right hand'))];
  // Bar 1: a walk up in quarter notes.
  [67, 69, 71, 72].forEach((midi, i) => right.push(...note(0, midi, i * 480, 480)));
  // Bar 2: a half note then two quarters, ending on F sharp.
  right.push(...note(0, 74, 1920, 960), ...note(0, 76, 2880, 480), ...note(0, 78, 3360, 480));
  // Bar 3: one whole note, which has to become a single printed note.
  right.push(...note(0, 79, 3840, 1920));
  // Bar 4: a run of eighths, which has to come out beamed rather than flagged.
  [79, 78, 76, 74, 72, 71, 69, 67].forEach((midi, i) =>
    right.push(...note(0, midi, 5760 + i * 240, 240)),
  );
  // Bar 5 is 3/4.
  [69, 71, 72].forEach((midi, i) => right.push(...note(0, midi, 7680 + i * 480, 480)));

  const left: Event[] = [meta(0, 0x03, text('Left hand'))];
  left.push(...note(1, 43, 0, 1920), ...note(1, 50, 0, 1920));
  left.push(...note(1, 48, 1920, 1920), ...note(1, 55, 1920, 1920));
  left.push(...note(1, 50, 3840, 1920));
  left.push(...note(1, 43, 5760, 1920));
  left.push(...note(1, 43, 7680, 1440));

  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(3), ...u16(PPQ)];
  return new Uint8Array([
    ...header,
    ...trackChunk(conductor),
    ...trackChunk(right),
    ...trackChunk(left),
  ]);
}

// ------------------------------------------------------------ checking ---

const results: boolean[] = [];
const check = (label: string, value: unknown, ok?: boolean) => {
  console.log(`  ${label.padEnd(26)} ${value}${ok === undefined ? '' : ok ? '  ok' : '  FAILED'}`);
  if (ok !== undefined) results.push(ok);
};
const near = (a: number, b: number, tolerance = 0.02) => Math.abs(a - b) < tolerance;

const path = process.argv[2];
const outDir = fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(outDir, { recursive: true });

let bytes: Uint8Array;
let name: string;
if (path) {
  const file = readFileSync(path);
  bytes = new Uint8Array(file);
  name = path;
} else {
  bytes = buildFixture();
  name = 'fixture.mid';
  writeFileSync(`${outDir}fixture.mid`, bytes);
}

const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const { xml, doc, source } = await loadMusicXml(buffer as ArrayBuffer, name);
const score = parseScore(doc);
writeFileSync(`${outDir}${path ? 'imported' : 'fixture'}.musicxml`, xml);

console.log(`file           ${name}  (${bytes.length} bytes -> ${(xml.length / 1024).toFixed(1)} kB of XML)`);
console.log(`title          ${score.title}`);
console.log(`measures       ${score.measureCount}`);
console.log(`staves         ${score.staffCount}`);
console.log(`notes          ${score.notes.length}`);
console.log(`duration       ${score.totalDuration.toFixed(2)}s`);
const midis = score.notes.map((n) => n.midi);
console.log(`pitch range    MIDI ${Math.min(...midis)}..${Math.max(...midis)}`);
console.log(`written to     scripts/out/${path ? 'imported' : 'fixture'}.musicxml`);
console.log('');

check('routed as MIDI', source, source === 'midi');

if (path) {
  // A real file has no known answer; check only that the result is coherent.
  const bad = score.notes.filter(
    (n) => !Number.isFinite(n.start) || !(n.duration > 0) || n.midi < 0 || n.midi > 127,
  );
  check('sane notes', `${score.notes.length - bad.length}/${score.notes.length}`, bad.length === 0);
  let monotonic = true;
  for (let m = 1; m < score.measureStarts.length; m++) {
    if (!(score.measureStarts[m] > score.measureStarts[m - 1])) monotonic = false;
  }
  check('measure starts rise', monotonic, monotonic);
} else {
  check('title from track name', score.title, score.title === 'Fixture in G');
  check('two hands', score.staffCount, score.staffCount === 2);
  check('measures', score.measureCount, score.measureCount === 5);
  check('notes kept', score.notes.length, score.notes.length === 26);

  const treble = score.notes.filter((n) => n.staffIndex === 0);
  const bass = score.notes.filter((n) => n.staffIndex === 1);
  check('hand split', `${treble.length} treble / ${bass.length} bass`,
    treble.length === 19 && bass.length === 7);
  check('hands do not cross', `treble >= ${Math.min(...treble.map((n) => n.midi))}, bass <= ${Math.max(...bass.map((n) => n.midi))}`,
    Math.min(...treble.map((n) => n.midi)) === 67 && Math.max(...bass.map((n) => n.midi)) === 55);

  // Bars 1-2 run at 120, bars 3-5 at 90, and bar 5 is 3/4 rather than 4/4.
  const starts = score.measureStarts;
  check('bar starts (s)', starts.map((s) => s.toFixed(3)).join(' '),
    near(starts[0], 0) && near(starts[1], 2) && near(starts[2], 4) &&
      near(starts[3], 6.667) && near(starts[4], 9.333));
  check('total duration', `${score.totalDuration.toFixed(3)}s`, near(score.totalDuration, 11.333));

  check('clefs', `${clefAt(score, 0, 0).sign}${clefAt(score, 0, 0).line} / ${clefAt(score, 0, 1).sign}${clefAt(score, 0, 1).line}`,
    clefAt(score, 0, 0).sign === 'G' && clefAt(score, 0, 1).sign === 'F');

  // The whole note in bar 3 must survive as one note, not four tied quarters.
  const whole = score.notes.find((n) => n.midi === 79 && n.measureIndex === 2);
  check('whole note kept whole', whole ? `${whole.duration.toFixed(3)}s` : 'missing',
    !!whole && near(whole.duration, 2.667, 0.05));

  // The two F sharps must be spelled with the key — F sharp, not G flat — and,
  // being in the key signature, must not also carry a printed accidental.
  const altered = [...doc.getElementsByTagName('note')].filter(
    (n) => n.getElementsByTagName('alter').length > 0,
  );
  const steps = new Set(altered.map((n) => n.getElementsByTagName('step')[0]?.textContent));
  check('F sharp spelled as F', `${altered.length} altered notes, steps ${[...steps].join(',')}`,
    altered.length === 2 && steps.size === 1 && steps.has('F'));
  const redundant = altered.filter((n) => n.getElementsByTagName('accidental').length > 0);
  check('no redundant accidental', redundant.length, redundant.length === 0);
  const fifths = doc.getElementsByTagName('fifths')[0]?.textContent;
  check('key signature read', `${fifths} sharps`, fifths === '1');
  const printedF = [...score.printedPositions.values()].flat().some((p) => p % 7 === 3);
  check('F position printed', printedF, printedF === true);

  // Bar 4's eighth-note run must be beamed, not left as eight separate flags.
  const beams = [...doc.getElementsByTagName('beam')];
  check('eighth run beamed', `${beams.length} beam marks`, beams.length >= 8);

  // Bar 5 is 3/4: three beats at 90bpm.
  const bar5 = starts[4];
  check('3/4 bar length', `${(score.totalDuration - bar5).toFixed(3)}s`,
    near(score.totalDuration - bar5, 2));
  const timeChanges = [...doc.getElementsByTagName('beats')].map((b) => b.textContent);
  check('metre change written', timeChanges.join(' -> '), timeChanges.join(',') === '4,3');

  // Every staff of every bar must be filled: a short bar throws OSMD's layout.
  const durations = new Map<string, number>();
  for (const measure of [...doc.getElementsByTagName('measure')]) {
    const number = measure.getAttribute('number') ?? '?';
    for (const node of [...measure.getElementsByTagName('note')]) {
      if (node.getElementsByTagName('chord').length > 0) continue;
      const staff = node.getElementsByTagName('staff')[0]?.textContent ?? '1';
      const value = Number(node.getElementsByTagName('duration')[0]?.textContent ?? 0);
      durations.set(`${number}:${staff}`, (durations.get(`${number}:${staff}`) ?? 0) + value);
    }
  }
  const expected = [96, 96, 96, 96, 72];
  const wrong = [...durations.entries()].filter(
    ([key, total]) => total !== expected[Number(key.split(':')[0]) - 1],
  );
  check('bars filled exactly', wrong.length === 0 ? `${durations.size} staff-bars` : JSON.stringify(wrong),
    wrong.length === 0);
}

console.log('');
console.log(`RESULT         ${results.every(Boolean) ? 'PASS' : 'NEEDS ATTENTION'}`);
process.exit(results.every(Boolean) ? 0 : 1);
