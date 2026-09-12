import { defineConfig } from 'vitest/config';
import { transformWithOxc } from 'vite';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, 'src');
// Vite reports module ids with forward slashes on every platform; path.resolve
// gives backslashes on Windows, so compare on a normalised form or the plugin
// below silently matches nothing there.
const posix = (value) => value.replace(/\\/g, '/');
const SRC_POSIX = posix(SRC);

// This codebase writes JSX inside `.js` files — Next's compiler accepts that,
// Vite's does not: it picks the parser from the extension, so a provider like
// lib/theme-context.js fails import analysis with "content contains invalid JS
// syntax". Rather than rename shipped files to suit the test runner, hand those
// files to the same transformer with the JSX parser turned on.
//
// @vitejs/plugin-react would also solve it, but it pulls a Babel 8 peer that
// conflicts with the Babel 7 the Next build already resolves, and nothing here
// needs Fast Refresh.
const jsxInJs = () => ({
  name: 'vendorconnect:jsx-in-js',
  enforce: 'pre',
  async transform(code, id) {
    const file = posix(id.split('?')[0]);
    if (!file.startsWith(SRC_POSIX) || !file.endsWith('.js')) return null;
    // Cheap guard so the pure-function modules skip the transform entirely.
    if (!/<[A-Za-z>]/.test(code)) return null;

    const result = await transformWithOxc(code, file, {
      lang: 'jsx',
      jsx: { runtime: 'automatic' },
    });
    return { code: result.code, map: result.map };
  },
});

export default defineConfig({
  plugins: [jsxInJs()],
  resolve: {
    alias: {
      '@': SRC,
    },
  },
  test: {
    // Backend tests are run separately with Jest (backend/tests)
    include: ['src/**/*.test.{js,jsx}'],
    // jsdom for everything, not only the component tests: the pure-function
    // suites under src/lib run identically under it, and one environment means
    // a new test file does not have to remember to declare one. Vitest still
    // executes in Node, so the cross-language registry guards that reach into
    // backend/ with createRequire keep working.
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.jsx'],
    // Each file gets a fresh module registry, so module-scope caches (whoami's
    // in-flight request, lib/socket's singleton) cannot leak between files.
    isolate: true,
  },
});
