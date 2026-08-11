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

console.log('');
console.log('screenshots      scripts/out/{render,with-guide}.png');
if (problems.length) {
  console.log('\npage errors:');
  for (const p of problems.slice(0, 10)) console.log(`  ${p}`);
}

await browser.close();
const ok = pass.every(Boolean) && problems.length === 0;
console.log(`\nRESULT           ${ok ? 'PASS' : 'NEEDS ATTENTION'}`);
process.exit(ok ? 0 : 1);
