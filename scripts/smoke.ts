/**
 * Parser smoke test: run the real pipeline over a score outside the browser.
 *
 *   npm run smoke [-- path/to/score.mxl]
 *
 * Checks the things that are easy to get silently wrong: measure timing across
 * changing meters and tempos, tie merging, and per-staff clef tracking.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html></html>');
// parseScore/loadMusicXml expect browser globals.
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;

const { loadMusicXml } = await import('../src/score/loadMusicXml');
const { parseScore } = await import('../src/score/parseScore');
const { clefAt } = await import('../src/score/types');

const path =
  process.argv[2] ?? 'public/examples/elden-ring-ost-the-final-battle-tsukasa-saitoh.mxl';
const file = readFileSync(path);
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);

const { xml, doc } = await loadMusicXml(buffer as ArrayBuffer, path);
const score = parseScore(doc);

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

console.log(`file           ${path}  (${(xml.length / 1024).toFixed(0)} kB of XML)`);
console.log(`title          ${score.title}${score.composer ? ` — ${score.composer}` : ''}`);
console.log(`measures       ${score.measureCount}`);
console.log(`staves         ${score.staffCount}`);
console.log(`notes          ${score.notes.length}`);
console.log(`duration       ${fmt(score.totalDuration)}`);

const midis = score.notes.map((n) => n.midi);
console.log(`pitch range    MIDI ${Math.min(...midis)}..${Math.max(...midis)}`);

const perStaff = new Map<number, number>();
for (const note of score.notes) perStaff.set(note.staffIndex, (perStaff.get(note.staffIndex) ?? 0) + 1);
console.log(`notes/staff    ${[...perStaff.entries()].sort().map(([s, n]) => `${s}:${n}`).join('  ')}`);

console.log(`clef changes   ${[...score.clefChanges.entries()].map(([k, c]) => `${k}=${c.sign}${c.line}`).join('  ')}`);

// Measure starts must be strictly increasing and finite.
let monotonic = true;
for (let m = 1; m < score.measureStarts.length; m++) {
  if (!(score.measureStarts[m] > score.measureStarts[m - 1])) monotonic = false;
}
console.log(`monotonic      ${monotonic ? 'ok' : 'FAILED — measure starts not increasing'}`);

const badNotes = score.notes.filter(
  (n) => !Number.isFinite(n.start) || !Number.isFinite(n.duration) || n.duration <= 0 || n.midi < 12 || n.midi > 108,
);
console.log(`sane notes     ${badNotes.length === 0 ? 'ok' : `FAILED — ${badNotes.length} bad`}`);

const overrun = score.notes.filter((n) => n.start > score.totalDuration + 0.001);
console.log(`within length  ${overrun.length === 0 ? 'ok' : `FAILED — ${overrun.length} start past the end`}`);

// Clef resolution should give the expected grand-staff default at bar 1.
console.log(
  `bar 1 clefs    treble staff = ${clefAt(score, 0, 0).sign}${clefAt(score, 0, 0).line}, ` +
    `bass staff = ${clefAt(score, 0, 1).sign}${clefAt(score, 0, 1).line}`,
);

// Spot-check the first few measures against their notes.
console.log('\nfirst 5 measures:');
for (let m = 0; m < Math.min(5, score.measureCount); m++) {
  const inBar = score.notes.filter((n) => n.measureIndex === m);
  const length = (score.measureStarts[m + 1] ?? score.totalDuration) - score.measureStarts[m];
  console.log(
    `  bar ${String(m + 1).padStart(2)}  start ${score.measureStarts[m].toFixed(2)}s  ` +
      `len ${length.toFixed(2)}s  notes ${String(inBar.length).padStart(2)}  ` +
      `midi [${inBar.map((n) => n.midi).join(',')}]`,
  );
}

const longest = [...score.notes].sort((a, b) => b.duration - a.duration)[0];
console.log(
  `\nlongest note   MIDI ${longest.midi} for ${longest.duration.toFixed(2)}s at bar ${longest.measureIndex + 1} (tie merging)`,
);
