import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Issue #121. Five helpers in usePOs.js invented SAP document numbers and
// randomised a business outcome — an inbound-delivery code, a GRN id, an MBLNR
// in the 50002… range, a PO number in the 45… range, and a
// `Math.random() > 0.85` rejected-quantity generator. None was referenced, but
// they sat in a live hook beside the real refreshPOs/refreshGRNs, one import
// away from being called again.
//
// Deleting them is a one-commit change that nothing stops from coming back, so
// this is the guard rather than a test of behaviour: the rule this codebase
// settled on (PROJECT_CONTEXT.md §5.6, and the same removal recorded in
// DashboardView.jsx's own comment about the invented UTR) is that nothing in
// this application produces a string indistinguishable from a real SAP
// identifier. A fabricator is only ever added by someone who did not know
// that, so the useful place to say it is at the point it would reappear.
//
// Scope is every non-test source file, not just usePOs.js, because the rule is
// repo-wide — and because scoping it to the one file #121 names would let the
// next one land anywhere else.

const SRC = join(process.cwd(), 'src');

// Two live uses of Math.random that this rule does not reach. Each needs a
// reason, and anything that is a defect rather than a legitimate use needs the
// issue tracking it (AGENTS.md: a test pinning known-imperfect behaviour links
// its issue, so the debt stays visible instead of curing into "that's just how
// it works").
const ALLOWED = [
  {
    file: 'lib/portal-context.js',
    reason: 'React list key for a transient toast — not a business identifier, never shown and never stored.',
  },
  {
    file: 'features/profile/hooks/useProfile.js',
    reason: 'getOrGenerateVendorId mints a `mock_vendor_NNNNN` supplier identity and sends it to the server. A real defect, not an allowance — tracked by issue #219, and this entry goes away with it.',
    issue: 219,
  },
];

const sourceFiles = (dir) => readdirSync(dir).flatMap((entry) => {
  const full = join(dir, entry);
  if (statSync(full).isDirectory()) return sourceFiles(full);
  if (!/\.(js|jsx|ts|tsx)$/.test(entry)) return [];
  if (/\.test\.|\.spec\./.test(entry)) return [];
  return [full];
});

// A comment recording that a fabricator was removed is the opposite of the
// problem — PurchaseOrdersView.jsx holds exactly such a note. Only real code
// counts, so line comments and block comments come out first.
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[^\n]*?\/\/.*$/gm, (line) => line.replace(/\/\/.*$/, ''));

describe('no fabricated SAP identifiers in frontend source (issue #121)', () => {
  const offenders = sourceFiles(SRC)
    .map((file) => ({
      file: relative(SRC, file).split(sep).join('/'),
      lines: stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .map((text, index) => ({ text, line: index + 1 }))
        .filter(({ text }) => text.includes('Math.random')),
    }))
    .filter(({ lines }) => lines.length);

  it('no source file outside the allow-list derives a value from Math.random', () => {
    const allowed = new Set(ALLOWED.map((entry) => entry.file));
    const unexpected = offenders
      .filter(({ file }) => !allowed.has(file))
      .map(({ file, lines }) => `${file}:${lines.map(({ line }) => line).join(',')}`);

    expect(unexpected).toEqual([]);
  });

  it('the allow-list has no stale entries', () => {
    const seen = new Set(offenders.map(({ file }) => file));
    const stale = ALLOWED.map((entry) => entry.file).filter((file) => !seen.has(file));

    // An entry whose file no longer uses Math.random has been fixed — remove
    // it, so the list never grows into a record of things nobody checks.
    expect(stale).toEqual([]);
  });

  it('usePOs.js holds no SAP-document-number generator', () => {
    const source = readFileSync(join(SRC, 'features/purchase-order/hooks/usePOs.js'), 'utf8');

    // The five by name, so a revert is named rather than merely counted.
    for (const name of [
      'generateInboundDeliveryCode',
      'generateGrnId',
      'generateSapMigoDoc',
      'calculateRejectedQuantity',
      'generatePoId',
    ]) {
      expect(source).not.toContain(name);
    }
  });
});
