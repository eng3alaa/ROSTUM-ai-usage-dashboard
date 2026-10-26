// Plan 9 / SPLIT — assembles AI Usage Dashboard.html from src/ by plain concatenation. The product stays one file; src/ is where edits land.
//
//   node tools/build.mjs            write AI Usage Dashboard.html from src/index.html + src/styles.css + src/js/<nn>-<name>.js (prefix order)
//   node tools/build.mjs --check    build in memory and exit 1 (with the first differing byte) when the committed file differs from it
//
// src/index.html holds two placeholder lines: `<!-- BUILD:STYLES -->` inside <style> and `<!-- BUILD:SCRIPTS -->` inside <script>; each is
// replaced by the parts' bytes verbatim. Nothing is re-indented or normalised: every part must be CRLF-only and end with CRLF (so the
// concatenation reproduces the original line structure) and must hold no raw control byte below 0x09; a missing or malformed part throws
// with the file named. The result is checked the same way before it is written. Node ≥ 20, no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'AI Usage Dashboard.html');
const STYLES_SLOT = '<!-- BUILD:STYLES -->\r\n';
const SCRIPTS_SLOT = '<!-- BUILD:SCRIPTS -->\r\n';
const PART_NAME = /^\d{2}-[a-z0-9-]+\.js$/;

/** every byte must survive unchanged, so parts travel as latin1 strings (one char per byte) and go back out the same way */
function readPart(file) {
  if (!fs.existsSync(file)) throw new Error(`missing part: ${path.relative(ROOT, file)}`);
  const text = fs.readFileSync(file, 'latin1');
  assertCrlfAndClean(text, path.relative(ROOT, file));
  return text;
}

function assertCrlfAndClean(text, name) {
  if (!text.endsWith('\r\n')) throw new Error(`${name}: must end with CRLF`);
  if (/(^|[^\r])\n/.test(text)) throw new Error(`${name}: bare LF found (every line must end with CRLF)`);
  const control = text.match(/[\x00-\x08]/);
  if (control) throw new Error(`${name}: raw control byte 0x${control[0].charCodeAt(0).toString(16).padStart(2, '0')} at offset ${control.index}`);
}

/** src/js/<nn>-<name>.js, in numeric-prefix order — the file names are the build order */
function scriptParts() {
  const dir = path.join(SRC, 'js');
  const names = fs.readdirSync(dir).filter(n => n.endsWith('.js')).sort();
  if (!names.length) throw new Error('src/js holds no parts');
  for (const n of names) if (!PART_NAME.test(n)) throw new Error(`src/js/${n}: part names are <nn>-<name>.js`);
  return names.map(n => readPart(path.join(dir, n)));
}

function fillSlot(html, slot, body) {
  const at = html.indexOf(slot);
  if (at < 0 || html.indexOf(slot, at + 1) >= 0) throw new Error(`src/index.html: expected exactly one ${slot.trim()} line`);
  return html.slice(0, at) + body + html.slice(at + slot.length);
}

export function build() {
  const skeleton = readPart(path.join(SRC, 'index.html'));
  const styles = readPart(path.join(SRC, 'styles.css'));
  const html = fillSlot(fillSlot(skeleton, STYLES_SLOT, styles), SCRIPTS_SLOT, scriptParts().join(''));
  assertCrlfAndClean(html, path.relative(ROOT, OUT));
  return Buffer.from(html, 'latin1');
}

function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { byte: i, line: a.subarray(0, i).toString('latin1').split('\n').length };
}

function check(built) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT) : Buffer.alloc(0);
  if (built.equals(current)) { console.log(`build: in sync (${built.length} bytes)`); return 0; }
  const { byte, line } = firstDifference(built, current);
  console.error(`build: DRIFT — ${path.basename(OUT)} differs from the build of src/ (first difference at byte ${byte}, line ${line}; built ${built.length} bytes, file ${current.length} bytes). Run: node tools/build.mjs`);
  return 1;
}

/** builds and writes the product file; returns its byte length (tests/tools/sync-prices.mjs calls this after rewriting its part) */
export function writeBuilt() {
  const built = build();
  fs.writeFileSync(OUT, built);
  return built.length;
}

export function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter(a => a !== '--check');
  if (unknown.length) throw new Error(`unknown argument ${unknown[0]} (the only flag is --check)`);
  if (argv.includes('--check')) return check(build());
  console.log(`build: wrote ${path.basename(OUT)} (${writeBuilt()} bytes)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(main()); } catch (e) { console.error('build: ' + (e && e.message || e)); process.exit(2); }
}
