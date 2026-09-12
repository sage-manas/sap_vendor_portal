import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// A route with no smoke test is how this suite silently stops covering the
// app. Rather than trust a reviewer to notice, this walks src/app for every
// page.jsx and asserts each one is imported by a test file — the same
// technique the nav registries already use against the backend permission map
// (lib/platformNav.test.js), applied to routes.

const APP = path.resolve(import.meta.dirname);
const SRC = path.resolve(APP, '..');

const walk = (dir, match) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full, match);
  return match(entry.name) ? [full] : [];
});

const asImportPath = (file) =>
  `@/${path.relative(SRC, file).split(path.sep).join('/').replace(/\.jsx$/, '')}`;

describe('route smoke coverage', () => {
  const pages = walk(APP, (name) => name === 'page.jsx');
  const tests = walk(SRC, (name) => name.endsWith('.test.jsx'));
  const allTestSource = tests.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

  it('found the app router pages', () => {
    expect(pages.length).toBeGreaterThan(30);
  });

  it.each(pages.map((page) => [asImportPath(page)]))('%s is imported by a test', (importPath) => {
    expect(allTestSource).toContain(importPath);
  });
});
