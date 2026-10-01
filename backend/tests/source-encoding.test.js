const fs = require('fs');
const path = require('path');

// A source file that is not valid UTF-8 is read by Node and by Jest, which are
// lenient, and rejected by the Next.js build ("failed to convert rope into
// string"), which is not. So it passes every test and breaks the deploy. It
// happened once: a tool wrote an em dash in the Windows code page.

const root = path.resolve(__dirname, '..', '..');
const SKIP = new Set(['node_modules', '.next', '.git', 'logs', 'uploads', 'test-results', 'coverage']);
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.css', '.md', '.sql', '.prisma']);

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  if (SKIP.has(entry.name) || entry.name.startsWith('.')) return [];
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  return EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
});

it('every source file is valid UTF-8', () => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const bad = walk(root).filter((file) => {
    try { decoder.decode(fs.readFileSync(file)); return false; } catch { return true; }
  }).map((file) => path.relative(root, file));
  expect(bad).toEqual([]);
});
