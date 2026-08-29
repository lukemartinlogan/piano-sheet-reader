/**
 * Draws the iOS app icon and launch image.
 *
 * They are generated rather than drawn by hand for one reason: the icon has to
 * carry the same idea as the app — a notehead with its own name printed in it,
 * in that letter's own colour — so it is drawn from the same palette the score
 * is, and cannot drift away from what the app actually puts on screen.
 *
 *   node scripts/make-app-art.mjs
 *
 * Needs Microsoft Edge or Chrome, the same as `npm run verify`: an SVG is laid
 * out by a real engine and screenshotted, so there is no rasteriser to vendor.
 */
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const icons = `${root}/ios/App/App/Assets.xcassets/AppIcon.appiconset`;
const splashes = `${root}/ios/App/App/Assets.xcassets/Splash.imageset`;

const BG = '#12141a';
/**
 * Brighter than the staff lines the app draws on white paper. An icon is read
 * at 60px on a home screen, where the in-app grey would vanish into the dark.
 */
const STAFF = '#616b80';

/** Three of the seven hues in src/render/palette.ts, in their `onDark` weight. */
const NOTES = [
  { letter: 'G', color: '#4ddbe0' },
  { letter: 'B', color: '#e08cff' },
  { letter: 'E', color: '#ffd84d' },
];

/**
 * The mark: three noteheads climbing a staff, each printed with its own name.
 *
 * `unit` is one staff space and every measurement is in those, so the same
 * drawing scales from a 1024px icon to a 2732px launch image with nothing
 * re-tuned. The heads climb space, line, space — alternating on purpose, since
 * telling a line from a space is the distinction the letter guide exists for.
 */
const mark = (unit) => {
  const staffWidth = unit * 8.4;
  const x0 = -staffWidth / 2;

  const lines = [];
  for (let i = 0; i < 5; i++) {
    const y = (i - 2) * unit;
    lines.push(
      `<line x1="${x0}" y1="${y}" x2="${x0 + staffWidth}" y2="${y}"` +
        ` stroke="${STAFF}" stroke-width="${unit * 0.1}" stroke-linecap="round" />`,
    );
  }

  const heads = NOTES.map((note, index) => {
    const cx = (index - 1) * unit * 2.5;
    const cy = unit * (1.5 - index * 1.5);
    return (
      `<g transform="translate(${cx} ${cy}) rotate(-18)">` +
      `<ellipse rx="${unit * 0.82}" ry="${unit * 0.62}" fill="${note.color}" /></g>` +
      `<text x="${cx}" y="${cy}" fill="${BG}" font-size="${unit * 0.92}"` +
      ` font-family="Helvetica, Arial, sans-serif" font-weight="700"` +
      ` text-anchor="middle" dominant-baseline="central">${note.letter}</text>`
    );
  });

  return lines.join('') + heads.join('');
};

const page = (size, unit) => `
<!doctype html>
<html><head><meta charset="utf-8" />
<style>html, body { margin: 0; background: ${BG}; } svg { display: block; }</style>
</head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG}" />
  <g transform="translate(${size / 2} ${size / 2})">${mark(unit)}</g>
</svg>
</body></html>`;

const shoot = async (browser, { size, unit, path }) => {
  const context = await browser.newContext({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  const tab = await context.newPage();
  await tab.setContent(page(size, unit), { waitUntil: 'load' });
  const png = await tab.screenshot({ type: 'png' });
  await writeFile(path, png);
  await context.close();
  return png.length;
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  await mkdir(icons, { recursive: true });
  await mkdir(splashes, { recursive: true });

  // iOS wants one 1024px icon and slices the rest itself. The mark is drawn
  // large: an icon is seen at 60px, where a polite margin leaves nothing.
  const iconBytes = await shoot(browser, {
    size: 1024,
    unit: 1024 / 9.6,
    path: `${icons}/AppIcon-512@2x.png`,
  });
  console.log(`icon    1024x1024  ${(iconBytes / 1024).toFixed(0)} KB`);

  // The launch image is a square, centre-cropped to whatever the screen is, so
  // the mark stays small enough to survive the crop in either orientation.
  for (const name of ['splash-2732x2732', 'splash-2732x2732-1', 'splash-2732x2732-2']) {
    const bytes = await shoot(browser, {
      size: 2732,
      unit: 2732 / 34,
      path: `${splashes}/${name}.png`,
    });
    console.log(`splash  2732x2732  ${(bytes / 1024).toFixed(0)} KB  ${name}.png`);
  }
} finally {
  await browser.close();
}
