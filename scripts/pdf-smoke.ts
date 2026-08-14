/**
 * PDF import check.
 *
 *   npm run pdf -- "path/to/score.pdf"
 *
 * There is no bundled fixture: writing a PDF by hand the way midi-smoke writes a
 * MIDI file would mean writing an engraver first, and a fixture drawn by this
 * project would only prove it can read its own output. So this runs against a
 * real PDF and reports what it found, asserting the things that must hold for
 * any engraving — staves in pairs, bars that divide, pitches in range — plus the
 * one number that says how much of the *rhythm* could be trusted:
 * bars whose note values add up to their own time signature.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html></html>');
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;

const { usePdfjs } = await import('../src/score/pdf/pdfContent');
usePdfjs((await import('pdfjs-dist/legacy/build/pdf.mjs')) as never);

const { pdfToMusicXml } = await import('../src/score/pdf/pdfToMusicXml');
const { parseScore } = await import('../src/score/parseScore');
const { clefAt } = await import('../src/score/types');

const path = process.argv[2];
if (!path) {
  console.error('usage: npm run pdf -- "path/to/score.pdf"');
  process.exit(2);
}

const outDir = fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const file = readFileSync(path);
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);

const started = Date.now();
const { xml, stats } = await pdfToMusicXml(buffer as ArrayBuffer, path);
const elapsed = Date.now() - started;
writeFileSync(`${outDir}imported-pdf.musicxml`, xml);

const doc = new dom.window.DOMParser().parseFromString(xml, 'application/xml');
const score = parseScore(doc as unknown as Document);

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
console.log(`file            ${path}`);
console.log(`read in         ${elapsed} ms`);
console.log(`pages           ${stats.pages}`);
console.log(`systems         ${stats.systems}   staves ${stats.staves}`);
console.log(`notehead glyph  ${stats.noteheadCode}`);
console.log(`tempo           ${stats.detectedTempo ?? 'not found, defaulted'}`);
console.log(`measures        ${stats.measures}`);
console.log(`notes           ${stats.notes}`);
console.log(`title           ${score.title}`);
console.log(`duration        ${fmt(score.totalDuration)}`);
const midis = score.notes.map((n) => n.midi);
console.log(`pitch range     MIDI ${Math.min(...midis)}..${Math.max(...midis)}`);
console.log(`written to      scripts/out/imported-pdf.musicxml`);
console.log('');

const exactPercent = (stats.exactMeasures / Math.max(1, stats.measures)) * 100;
console.log(`RHYTHM   bars that add up exactly: ${stats.exactMeasures}/${stats.measures}  (${exactPercent.toFixed(1)}%)`);
console.log(`         bars spaced by position:  ${stats.fallbackMeasures}`);

// When bars do not add up, the shape of the error says why: consistently over
// means note values are being read too long (beams missed), consistently under
// means notes are being missed outright.
const ratios = stats.bars.filter((b) => b.events > 0).map((b) => b.sum / b.expected);
if (ratios.length > 0) {
  const sorted = [...ratios].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.floor(sorted.length * q)].toFixed(2);
  console.log(`         sum/expected p10 ${at(0.1)}  median ${at(0.5)}  p90 ${at(0.9)}`);
  console.log(`         bars over ${ratios.filter((r) => r > 1.01).length}  under ${ratios.filter((r) => r < 0.99).length}  exact ${ratios.filter((r) => Math.abs(r - 1) <= 0.01).length}`);
}
if (process.argv.includes('--bars')) {
  console.log('\n  bar staff  events beamed     sum / expected');
  for (const b of stats.bars.slice(0, 30)) {
    console.log(
      `  ${String(b.bar).padStart(3)} ${String(b.staff).padStart(5)} ${String(b.events).padStart(7)} ${String(b.beamed).padStart(6)}   ${String(b.sum).padStart(6)} / ${b.expected}`,
    );
  }
}
console.log('');

const results: boolean[] = [];
const check = (label: string, value: unknown, ok: boolean) => {
  console.log(`  ${label.padEnd(28)} ${value}${ok ? '  ok' : '  FAILED'}`);
  results.push(ok);
};

check('staves found', stats.staves, stats.staves > 0);
check('staves pair into systems', `${stats.staves} staves / ${stats.systems} systems`,
  stats.systems > 0 && stats.staves % stats.systems === 0);
check('measures found', stats.measures, stats.measures > 0);
check('notes found', stats.notes, stats.notes > 0);
check('two hands', score.staffCount, score.staffCount === 2);
check('clefs', `${clefAt(score, 0, 0).sign}${clefAt(score, 0, 0).line} / ${clefAt(score, 0, 1).sign}${clefAt(score, 0, 1).line}`,
  clefAt(score, 0, 0).sign === 'G' && clefAt(score, 0, 1).sign === 'F');

const playable = score.notes.filter((n) => n.midi >= 21 && n.midi <= 108);
check('pitches on a piano', `${playable.length}/${score.notes.length}`, playable.length === score.notes.length);

const bad = score.notes.filter((n) => !Number.isFinite(n.start) || !(n.duration > 0));
check('durations sane', `${score.notes.length - bad.length}/${score.notes.length}`, bad.length === 0);

let monotonic = true;
for (let m = 1; m < score.measureStarts.length; m++) {
  if (!(score.measureStarts[m] > score.measureStarts[m - 1])) monotonic = false;
}
check('bar starts rise', monotonic, monotonic);

// Every staff of every bar must be filled exactly, or OSMD's layout breaks.
const totals = new Map<string, number>();
for (const measure of [...doc.getElementsByTagName('measure')]) {
  const number = measure.getAttribute('number') ?? '?';
  for (const note of [...measure.getElementsByTagName('note')]) {
    if (note.getElementsByTagName('chord').length > 0) continue;
    const staff = note.getElementsByTagName('staff')[0]?.textContent ?? '1';
    const value = Number(note.getElementsByTagName('duration')[0]?.textContent ?? 0);
    totals.set(`${number}:${staff}`, (totals.get(`${number}:${staff}`) ?? 0) + value);
  }
}
const perBar = new Map<string, number>();
for (const [key, total] of totals) {
  const bar = key.split(':')[0];
  if (!perBar.has(bar)) perBar.set(bar, total);
}
const uneven = [...totals.entries()].filter(([key, total]) => total !== perBar.get(key.split(':')[0]));
check('staves agree per bar', uneven.length === 0 ? `${totals.size} staff-bars` : JSON.stringify(uneven.slice(0, 4)),
  uneven.length === 0);

// The point of the whole exercise: pitch has to be right, so the letter guide
// has something true to label. A wrong staff assignment shows up as a hand
// playing far outside its range.
const treble = score.notes.filter((n) => n.staffIndex === 0);
const bass = score.notes.filter((n) => n.staffIndex === 1);
const meanOf = (list: typeof score.notes) => list.reduce((s, n) => s + n.midi, 0) / Math.max(1, list.length);
check('right hand above left', `${meanOf(treble).toFixed(1)} vs ${meanOf(bass).toFixed(1)}`,
  meanOf(treble) > meanOf(bass));

check('rhythm verified > 50%', `${exactPercent.toFixed(1)}%`, exactPercent > 50);

console.log('');
console.log(`RESULT          ${results.every(Boolean) ? 'PASS' : 'NEEDS ATTENTION'}`);
process.exit(results.every(Boolean) ? 0 : 1);
