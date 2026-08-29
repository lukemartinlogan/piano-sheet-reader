/**
 * Repairs the local package paths in the generated `ios/App/CapApp-SPM/Package.swift`.
 *
 * `cap sync` writes those paths with the host's separator, so syncing on Windows
 * emits `path: "..\..\..\node_modules\@capacitor\app"`. That is broken twice
 * over on the Mac that has to build it: the separator is wrong, and `\n` inside
 * a Swift string literal is a newline, so `\node_modules` does not even survive
 * as text. Swift Package Manager wants POSIX separators on every platform, so
 * the fix is simply to write them.
 *
 * Runs as the last step of `npm run ios`. On macOS it finds nothing to do.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../ios/App/CapApp-SPM/Package.swift',
);

const source = await readFile(file, 'utf8');

// Only the `path:` arguments are touched; nothing else in the file is a path,
// and a blanket replace would corrupt any genuine Swift escape.
const fixed = source.replace(/path:\s*"([^"]*)"/g, (match, path) =>
  path.includes('\\') ? `path: "${path.replaceAll('\\', '/')}"` : match,
);

if (fixed === source) {
  console.log('Package.swift  paths already POSIX');
} else {
  await writeFile(file, fixed, 'utf8');
  console.log('Package.swift  rewrote Windows separators as POSIX');
}
