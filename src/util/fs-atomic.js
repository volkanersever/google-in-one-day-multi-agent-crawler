// Small atomic I/O helpers.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Append a single line atomically. The line terminator MUST be '\n' and the
 * combined bytes MUST stay under PIPE_BUF (4 KB) so POSIX guarantees atomicity.
 * We do not check length here because tokenize() caps word length and URLs are
 * capped upstream; callers that may exceed the cap should split themselves.
 */
export function appendLineSync(filePath, line) {
  if (!line.endsWith('\n')) line += '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line, { flag: 'a' });
}

/** Atomically replace a JSON file: write to .tmp then rename. */
export function writeJsonAtomicSync(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

export function readJsonSync(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
