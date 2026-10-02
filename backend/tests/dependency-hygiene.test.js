const fs = require('fs');
const path = require('path');

// 1.9 — the root package.json (the Next.js app) used to list the API's runtime
// dependencies too: express, helmet, multer, jsonwebtoken, socket.io and so on.
// Nothing in src/ imports them; they were installed on the frontend build, widened
// its audit surface, and made `npm audit` report advisories for code the browser
// never runs. A package the API needs belongs in backend/package.json only.

const read = (file) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8'));

describe('package manifests', () => {
  it('the frontend does not depend on a package the API depends on', () => {
    const frontend = Object.keys(read('package.json').dependencies);
    const backend = Object.keys(read('backend/package.json').dependencies);

    expect(frontend.filter((name) => backend.includes(name))).toEqual([]);
  });

  it('the frontend does not ship the shadcn CLI, whose one stylesheet is vendored', () => {
    const { dependencies, devDependencies } = read('package.json');
    expect(Object.keys({ ...dependencies, ...devDependencies })).not.toContain('shadcn');
    expect(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'app', 'globals.css'), 'utf8')).not.toMatch(/@import\s+["']shadcn\//);
  });
});
