/**
 * Render verification: load the app in a real browser and check the reading aids
 * against what the renderer actually drew.
 *
 *   npm run verify            (expects `npm run preview` on :4173)
 *   npm run verify -- <url>
 *
 * Runs in two phases: the default view (letters inside noteheads), then with the
 * margin guide switched on. Screenshots land in scripts/out/.
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = process.argv[2] ?? 'http://localhost:4173/';
const outDir = fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const problems = [];
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().endsWith('favicon.ico')) {
    problems.push(`${response.status()} ${response.url()}`);
  }
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.note-letter', { timeout: 30000 });
await page.waitForTimeout(1500);

const snapshot = () =>
  page.evaluate(() => {
    const svg = document.querySelector('.score-host svg');
    if (!svg) return { error: 'no svg rendered' };

    // Staff lines are unclassed horizontal paths directly inside g.vf-measure.
    const staffLineYs = new Set();
    for (const path of svg.querySelectorAll('g.vf-measure > path')) {
      const box = path.getBBox();
      if (box.height <= 2 && box.width > 60) {
        staffLineYs.add(Math.round((box.y + box.height / 2) * 100) / 100);
      }
    }

    const columns = Array.from(svg.querySelectorAll('.gutter-column')).map((g) => {
      const texts = Array.from(g.querySelectorAll('text')).map((t) => ({
        text: t.textContent,
        y: parseFloat(t.getAttribute('y')),
        isLine: t.classList.contains('gutter-letter-line'),
        fill: t.getAttribute('fill'),
      }));
      texts.sort((a, b) => b.y - a.y); // bottom to top
      return {
        clef: g.getAttribute('data-clef'),
        staff: Number(g.getAttribute('data-staff')),
        low: Number(g.getAttribute('data-low')),
        high: Number(g.getAttribute('data-high')),
        font: Number(g.getAttribute('data-font')),
        labels: g.getAttribute('data-labels') === 'true',
        letters: texts.map((t) => t.text).join(' '),
        lineLabels: texts.filter((t) => t.isLine),
        spaceLabels: texts.filter((t) => !t.isLine),
        ledgerRules: g.querySelectorAll('.gutter-ledger-rule').length,
      };
    });

    // Nothing the margin guide draws may sit on top of a notehead.
    const gutterBoxes = Array.from(svg.querySelectorAll('.letter-gutter text')).map((t) => t.getBBox());
    const noteBoxes = Array.from(svg.querySelectorAll('g.vf-notehead')).map((n) => n.getBBox());
    let collisions = 0;
    for (const a of gutterBoxes) {
      for (const b of noteBoxes) {
        if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) {
          collisions++;
          break;
        }
      }
    }

    // --- letters inside noteheads ---
    const LETTERS = 'CDEFGAB';
    const score = window.__score;
    let totalExpected = 0;
    if (score) for (const v of score.printedPositions.values()) totalExpected += v.length;

    const noteLetters = Array.from(svg.querySelectorAll('.note-letter'));
    // A letter is only useful if it contrasts with the head it sits on. A filled
    // head is black, a hollow head's centre is the white page, so measure the
    // letter's luminance against the right one rather than testing for a colour.
    const luminance = (css) => {
      const m = (css ?? '').match(/(\d+(?:\.\d+)?)/g);
      if (!m || m.length < 3) return null;
      return 0.2126 * +m[0] + 0.7152 * +m[1] + 0.0722 * +m[2];
    };
    let invisible = 0;
    let onHollow = 0;
    let onFilled = 0;
    let dimmest = 255;
    let brightestOnWhite = 0;
    const noteheadFills = new Set();
    for (const t of noteLetters) {
      const hollow = t.getAttribute('data-hollow') === 'true';
      const lum = luminance(getComputedStyle(t).fill);
      if (lum === null) continue;
      if (hollow) {
        onHollow++;
        brightestOnWhite = Math.max(brightestOnWhite, lum);
        if (lum > 150) invisible++; // too pale for the white hole
      } else {
        onFilled++;
        dimmest = Math.min(dimmest, lum);
        if (lum < 110) invisible++; // too dark for a black head
      }
    }
    // Filled heads must keep VexFlow's own black; hollow heads intentionally
    // take the letter's colour on their outline.
    const filledFills = new Set();
    for (const head of svg.querySelectorAll('g.vf-notehead')) {
      let moves = 0;
      for (const p of head.querySelectorAll('path')) {
        moves += (p.getAttribute('d') ?? '').match(/[Mm]/g)?.length ?? 0;
      }
      for (const p of head.querySelectorAll('path')) {
        const fill = p.getAttribute('fill') ?? getComputedStyle(p).fill;
        noteheadFills.add(fill);
        if (moves < 3) filledFills.add(fill);
      }
    }

    let checkedGroups = 0;
    let mismatchedGroups = 0;
    const mismatchSample = [];
    if (score) {
      const drawn = new Map();
      for (const t of noteLetters) {
        const key = `${t.getAttribute('data-measure')}:${t.getAttribute('data-staff')}`;
        if (!drawn.has(key)) drawn.set(key, []);
        drawn.get(key).push(t.textContent);
      }
      for (const [key, letters] of drawn) {
        const positions = score.printedPositions.get(key);
        if (!positions) continue;
        const expected = positions.map((d) => LETTERS[((d % 7) + 7) % 7]).sort().join('');
        const got = [...letters].sort().join('');
        checkedGroups++;
        if (expected !== got) {
          mismatchedGroups++;
          if (mismatchSample.length < 5) mismatchSample.push({ key, expected, got });
        }
      }
    }

    return {
      columns,
      collisions,
      staffLines: [...staffLineYs].sort((a, b) => a - b),
      noteheads: noteBoxes.length,
      clefs: svg.querySelectorAll('g.vf-clef').length,
      bands: svg.querySelectorAll('.gutter-band').length,
      ledgerRules: svg.querySelectorAll('.gutter-ledger-rule').length,
      gutterIsFirstChild: svg.firstElementChild?.classList.contains('letter-gutter') ?? false,
      noteLetters: noteLetters.length,
      expectedNotes: totalExpected,
      invisibleLetters: invisible,
      lettersOnHollow: onHollow,
      lettersOnFilled: onFilled,
      dimmestOnBlack: Math.round(dimmest),
      brightestOnWhite: Math.round(brightestOnWhite),
      noteheadFills: [...noteheadFills],
      filledHeadFills: [...filledFills],
      hasScore: Boolean(score),
      expectedGroups: score ? score.printedPositions.size : 0,
      unmatchedMeasures: Number(
        document.querySelector('[data-unmatched-measures]')?.getAttribute('data-unmatched-measures') ?? -1,
      ),
      checkedGroups,
      mismatchedGroups,
      mismatchSample,
      distinctInks: new Set(
        Array.from(svg.querySelectorAll('.letter-gutter text')).map((t) => t.getAttribute('fill')),
      ).size,
      distinctBandFills: new Set(
        Array.from(svg.querySelectorAll('.gutter-band')).map((r) => r.getAttribute('fill')),
      ).size,
    };
  });

/**
 * Two bars of C major, right hand over left, as a Standard MIDI File.
 *
 * Written out byte by byte so this check needs nothing on disk and nothing from
 * the import code it is checking. `npm run midi` exercises the converter in
 * depth; this only has to prove a real .mid survives the trip through the
 * browser and comes out engraved.
 */
function midiFixture() {
  const varlen = (value) => {
    const bytes = [value & 0x7f];
    let rest = value >> 7;
    while (rest > 0) {
      bytes.unshift((rest & 0x7f) | 0x80);
      rest >>= 7;
    }
    return bytes;
  };
  const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
  const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

  const chunk = (events) => {
    const body = [];
    let last = 0;
    for (const event of [...events].sort((a, b) => a.tick - b.tick || a.order - b.order)) {
      body.push(...varlen(event.tick - last), ...event.data);
      last = event.tick;
    }
    body.push(0, 0xff, 0x2f, 0);
    return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
  };
  const meta = (tick, type, bytes) => ({ tick, data: [0xff, type, bytes.length, ...bytes], order: -1 });
  const note = (channel, midi, tick, length) => [
    { tick, data: [0x90 | channel, midi, 80], order: 1 },
    { tick: tick + length, data: [0x80 | channel, midi, 0], order: 0 },
  ];

  const right = [
    meta(0, 0x03, [...'Browser check'].map((c) => c.charCodeAt(0))),
    meta(0, 0x58, [4, 2, 24, 8]),
    meta(0, 0x51, [0x07, 0xa1, 0x20]),
    ...[60, 62, 64, 65, 67, 69, 71, 72].flatMap((midi, i) => note(0, midi, i * 480, 480)),
  ];
  const left = [...note(1, 48, 0, 1920), ...note(1, 43, 1920, 1920)];

  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(2), ...u16(480),
    ...chunk(right),
    ...chunk(left),
  ]);
}

const pass = [];
const record = (label, value, ok) => {
  console.log(`  ${label.padEnd(26)} ${value}${ok === undefined ? '' : ok ? '  ok' : '  FAILED'}`);
  if (ok !== undefined) pass.push(ok);
};

// ---------------------------------------------------------------- phase 1 ---
const base = await snapshot();
if (base.error) {
  console.error(`FAILED: ${base.error}`);
  await browser.close();
  process.exit(1);
}

console.log('letters inside noteheads (default view)');
record('score exposed for check', base.hasScore, base.hasScore === true);
// The notehead count includes rests, which VexFlow draws with identical markup.
record(
  'letters drawn',
  `${base.noteLetters} for ${base.expectedNotes} notes (${base.noteheads - base.expectedNotes} rests skipped)`,
  base.noteLetters === base.expectedNotes,
);
record('on hollow / filled heads', `${base.lettersOnHollow} / ${base.lettersOnFilled}`,
  base.lettersOnHollow > 100 && base.lettersOnFilled > 100);
record('letters invisible on head', base.invisibleLetters, base.invisibleLetters === 0);
record('luminance on black / white', `min ${base.dimmestOnBlack} / max ${base.brightestOnWhite}`,
  base.dimmestOnBlack >= 110 && base.brightestOnWhite <= 150);
// Solid noteheads must keep VexFlow's own black — the notation is not repainted.
// Hollow heads are the deliberate exception: their outline carries the colour.
const VEXFLOW_FILLS = ['#000000', '#00000000', 'rgb(0, 0, 0)', 'rgba(0, 0, 0, 0)', 'black', 'none', null];
record('solid heads keep own colour', base.filledHeadFills.join(', ') || '(none)',
  base.filledHeadFills.every((f) => VEXFLOW_FILLS.includes(f)));
record('hollow outlines coloured',
  `${base.noteheadFills.filter((f) => !VEXFLOW_FILLS.includes(f)).length} distinct hues`,
  base.noteheadFills.filter((f) => !VEXFLOW_FILLS.includes(f)).length >= 6);
// A measure the renderer cannot place silently loses all its letters, and the
// drift that causes it grows down the page — so check coverage, not just totals.
record('measures unplaceable', base.unmatchedMeasures, base.unmatchedMeasures === 0);
record('measures cross-checked', `${base.checkedGroups}/${base.expectedGroups}`,
  base.checkedGroups === base.expectedGroups);
record('letters match pitches', `${base.checkedGroups - base.mismatchedGroups}/${base.checkedGroups}`,
  base.mismatchedGroups === 0);
for (const m of base.mismatchSample) console.log(`      ${m.key}  expected ${m.expected}  got ${m.got}`);
record('margin guide off by default', base.columns.length, base.columns.length === 0);
await page.screenshot({ path: `${outDir}render.png` });

// ---------------------------------------------------------------- phase 2 ---
console.log('');
console.log('margin guide (switched on)');
await page.click('button:has-text("Settings")');
await page.selectOption('.settings fieldset:first-of-type select', 'measure');
await page.waitForTimeout(2500);
const guide = await snapshot();

record('columns drawn', guide.columns.length, guide.columns.length > 200);
record('letters over noteheads', guide.collisions, guide.collisions === 0);
const fonts = guide.columns.map((c) => c.font).filter(Number.isFinite);
record('letter size', `${[...new Set(fonts.map((f) => f.toFixed(1)))].join(', ')} svg units`,
  new Set(fonts.map((f) => f.toFixed(2))).size === 1);
const lettered = guide.columns.filter((c) => c.labels).length;
record('columns with letters', `${lettered}/${guide.columns.length}`, lettered / guide.columns.length > 0.97);
record('notes drawn above guide', guide.gutterIsFirstChild, guide.gutterIsFirstChild === true);

const alignment = (name, staffIndex, expectedLineLetters, staffLines) => {
  const column = guide.columns.find((c) => c.staff === staffIndex);
  console.log(`\n  ${name} (clef ${column.clef}, rows ${column.low}..${column.high})`);
  const onStaff = column.lineLabels.filter((l) => staffLines.some((y) => Math.abs(y - l.y) < 1.5));
  const got = onStaff.map((l) => l.text).join('');
  record('line letters on staff', got, got === expectedLineLetters);
  const descending = [...staffLines].sort((a, b) => b - a);
  const worst = Math.max(...onStaff.map((l, i) => Math.abs(l.y - descending[i])));
  record('worst line mismatch', `${worst.toFixed(2)} px`, worst < 1.5);
};
alignment('treble staff', 0, 'EGBDF', guide.staffLines.slice(0, 5));
alignment('bass staff', 1, 'GBDFA', guide.staffLines.slice(5, 10));

console.log('');
record('distinct letter inks', guide.distinctInks, guide.distinctInks >= 6);
const trebleCol = guide.columns.find((c) => c.staff === 0);
const bassCol = guide.columns.find((c) => c.staff === 1);
const inkOf = (col, letter) =>
  [...col.lineLabels, ...col.spaceLabels].find((l) => l.text === letter)?.fill;
const shared = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].filter((l) => inkOf(trebleCol, l) && inkOf(bassCol, l));
record('same letter same colour', `${shared.length} letters compared`,
  shared.length >= 6 && shared.every((l) => inkOf(trebleCol, l) === inkOf(bassCol, l)));

const deepest = Math.min(...guide.columns.map((c) => c.low));
const highest = Math.max(...guide.columns.map((c) => c.high));
record('extends below / above', `${deepest} .. ${highest}`, deepest < 0 && highest > 8);
record('extension rules drawn', guide.ledgerRules, guide.ledgerRules > 0);

const upperBass = guide.columns.filter((c) => c.staff === 0 && c.clef === 'F4');
record('upper staff relabelled', `${upperBass.length} bass-clef columns`,
  upperBass.length > 0 && upperBass.every((c) => c.lineLabels.map((l) => l.text).join('').includes('GBDFA')));
await page.screenshot({ path: `${outDir}with-guide.png` });

// ------------------------------------------------------------ size slider ---
// Re-engraving the whole score is expensive, so dragging Size must not commit
// on every step; it should apply once, on release.
console.log('');
console.log('size slider');
await page.evaluate(() => {
  window.__renders = 0;
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.tagName === 'svg') window.__renders++;
  }).observe(document.querySelector('.score-host'), { childList: true, subtree: true });
});
const sizeSlider = page.locator('.settings input[type=range]').first();
const sliderBox = await sizeSlider.boundingBox();
await page.mouse.move(sliderBox.x + sliderBox.width * 0.3, sliderBox.y + sliderBox.height / 2);
await page.mouse.down();
for (let i = 0; i <= 15; i++) {
  await page.mouse.move(sliderBox.x + sliderBox.width * (0.3 + 0.015 * i), sliderBox.y + sliderBox.height / 2);
}
const midDrag = await page.evaluate(() => ({
  renders: window.__renders,
  readout: document.querySelectorAll('.settings .readout')[0]?.textContent,
}));
record('re-renders while dragging', `${midDrag.renders} (readout tracks: ${midDrag.readout})`, midDrag.renders === 0);
await page.mouse.up();
await page.waitForTimeout(6000);
const afterDrag = await page.evaluate(() => ({
  renders: window.__renders,
  letters: document.querySelectorAll('.note-letter').length,
  banner: document.querySelector('.banner-error')?.textContent ?? null,
}));
record('re-renders on release', afterDrag.renders, afterDrag.renders === 1);
record('score survives resize', `${afterDrag.letters} letters${afterDrag.banner ? ' BANNER: ' + afterDrag.banner : ''}`,
  afterDrag.letters > 1700 && !afterDrag.banner);

// ---------------------------------------------------------------- playback ---
console.log('');
console.log('playback');
await page.click('button:has-text("Settings")');
await page.click('.transport-play');
await page.waitForTimeout(2500);
const during = await page.evaluate(() => ({
  seek: Number(document.querySelector('.seek')?.value ?? 0),
  highlights: document.querySelectorAll('.measure-highlight').length,
}));
record('position advances', `${during.seek.toFixed(2)}s`, during.seek > 0.5);
record('measure highlight', during.highlights, during.highlights === 1);
await page.click('.transport-play');
await page.waitForTimeout(300);
const paused = await page.evaluate(() => Number(document.querySelector('.seek')?.value ?? 0));
await page.waitForTimeout(600);
const stillPaused = await page.evaluate(() => Number(document.querySelector('.seek')?.value ?? 0));
record('pause holds position', `${paused} -> ${stillPaused}`, paused === stillPaused);

// ---------------------------------------------------------- keyboard view ---
// The falling-notes view is a canvas, so there is nothing in the DOM to read.
// It publishes what it drew on the container instead, which is what is checked
// here: the key range it fitted to the score, and keys lighting up as it plays.
console.log('');
console.log('keyboard view');
await page.click('button:has-text("Stop"), .toolbar-transport button:nth-of-type(2)').catch(() => {});
await page.click('.view-switch button:has-text("Keyboard")');
await page.waitForTimeout(400);

const rollBox = await page.evaluate(() => {
  const roll = document.querySelector('.piano-roll');
  const canvas = roll?.querySelector('canvas');
  if (!roll || !canvas) return null;
  return {
    low: Number(roll.dataset.lowKey),
    high: Number(roll.dataset.highKey),
    width: canvas.width,
    height: canvas.height,
    sheetVisible: getComputedStyle(document.querySelector('.score-scroll').parentElement).visibility,
  };
});
record('canvas sized', rollBox ? `${rollBox.width}x${rollBox.height}` : 'missing',
  !!rollBox && rollBox.width > 100 && rollBox.height > 100);
record('key range fitted', rollBox ? `MIDI ${rollBox.low}..${rollBox.high}` : '—',
  !!rollBox && rollBox.low >= 21 && rollBox.high <= 108 && rollBox.high - rollBox.low >= 24);
record('sheet kept mounted', rollBox?.sheetVisible, rollBox?.sheetVisible === 'hidden');

// A canvas that paints nothing still passes a DOM check, so compare pixels.
const blankPixels = await page.evaluate(() => {
  const canvas = document.querySelector('.piano-roll canvas');
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const seen = new Set();
  for (let i = 0; i < data.length; i += 4 * 97) {
    seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
  }
  return seen.size;
});
record('distinct pixel colours', blankPixels, blankPixels > 4);

await page.click('.transport-play');
let keysSeen = 0;
for (let i = 0; i < 20 && keysSeen === 0; i++) {
  await page.waitForTimeout(250);
  keysSeen = await page.evaluate(() =>
    Number(document.querySelector('.piano-roll')?.dataset.keysDown ?? 0),
  );
}
record('keys light while playing', keysSeen, keysSeen > 0);
await page.screenshot({ path: `${outDir}keyboard.png` });
await page.click('.transport-play');

// Tapping a key has to sound without disturbing the transport.
const beforeTap = await page.evaluate(() => Number(document.querySelector('.seek')?.value ?? 0));
const canvasBox = await page.locator('.piano-roll canvas').boundingBox();
await page.mouse.click(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height - 20);
await page.waitForTimeout(150);
const afterTap = await page.evaluate(() => Number(document.querySelector('.seek')?.value ?? 0));
record('key tap leaves position', `${beforeTap} -> ${afterTap}`, beforeTap === afterTap);

// Switching back must not re-engrave: the sheet was hidden, not unmounted.
const rendersBefore = await page.evaluate(() => window.__renders);
await page.click('.view-switch button:has-text("Sheet")');
await page.waitForTimeout(600);
const afterSwitch = await page.evaluate(() => ({
  renders: window.__renders,
  letters: document.querySelectorAll('.note-letter').length,
}));
record('sheet not re-engraved', `${rendersBefore} -> ${afterSwitch.renders} renders`,
  afterSwitch.renders === rendersBefore && afterSwitch.letters > 1700);

// ----------------------------------------------------------- midi import ---
// A .mid has to come out the far side as an engraved score, with every letter
// matching the pitch the parser read — the same cross-check as phase 1, run
// against notation this app generated rather than notation it was given.
console.log('');
console.log('midi import');
await page.setInputFiles('input[type=file]', {
  name: 'browser-check.mid',
  mimeType: 'audio/midi',
  buffer: Buffer.from(midiFixture()),
});
await page.waitForTimeout(3000);

const midiState = await page.evaluate(() => ({
  title: document.querySelector('.score-title')?.textContent,
  badge: document.querySelector('.score-source')?.textContent?.trim() ?? null,
  banner: document.querySelector('.banner-error')?.textContent ?? null,
  staves: document.querySelectorAll('g.vf-stave').length,
}));
record('opened without error', midiState.banner ?? 'no banner', midiState.banner === null);
record('title from the file', midiState.title, midiState.title === 'Browser check');
record('flagged as MIDI', midiState.badge, midiState.badge === 'from MIDI');

const imported = await snapshot();
record('engraved by OSMD', `${imported.noteheads} noteheads`, imported.noteheads >= 10);
record('letters drawn', `${imported.noteLetters}/${imported.expectedNotes}`,
  imported.noteLetters === imported.expectedNotes && imported.expectedNotes === 10);
record('letters match pitches', `${imported.checkedGroups - imported.mismatchedGroups}/${imported.checkedGroups}`,
  imported.mismatchedGroups === 0 && imported.checkedGroups > 0);
for (const m of imported.mismatchSample) console.log(`      ${m.key}  expected ${m.expected}  got ${m.got}`);
record('both hands engraved', `${imported.expectedGroups} measure-staff groups`,
  imported.expectedGroups >= 4);
await page.screenshot({ path: `${outDir}midi-import.png` });

console.log('');
console.log('screenshots      scripts/out/{render,with-guide,keyboard,midi-import}.png');
if (problems.length) {
  console.log('\npage errors:');
  for (const p of problems.slice(0, 10)) console.log(`  ${p}`);
}

await browser.close();
const ok = pass.every(Boolean) && problems.length === 0;
console.log(`\nRESULT           ${ok ? 'PASS' : 'NEEDS ATTENTION'}`);
process.exit(ok ? 0 : 1);
