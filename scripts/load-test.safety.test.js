import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// scripts/load-test.js cannot be executed here — it imports `k6/http`, which
// only exists inside the k6 runtime. What can be checked, and is worth
// checking, is the property that makes the script safe to hand to an operator.
//
// A load test is run by someone under pressure, against whatever BASE_URL is
// in their shell history. This one is read-only on purpose: a write against a
// tenant whose driver is `s4_odata` reaches that customer's real SAP, and
// `createAssetPo` creates an actual purchase order there that nothing cleans
// up. CLT-0001 is wired to a live sandbox.
//
// That property is one `http.post` away from being untrue, and the person who
// adds it will be trying to measure write throughput, which is a reasonable
// thing to want. This is the test that makes them do it in a separate script
// instead — which is what the runbook asks for, so that nobody runs the write
// test against the wrong environment out of habit.

const SOURCE = readFileSync(join(process.cwd(), 'scripts', 'load-test.js'), 'utf8');

// Comments describe the rule; only code can break it.
const code = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[^\n]*?\/\/.*$/gm, (line) => line.replace(/\/\/.*$/, ''));

describe('the load test stays read-only', () => {
  it('issues no HTTP verb other than get and the one login post', () => {
    const calls = [...code.matchAll(/\bhttp\.(\w+)\s*\(/g)].map((match) => match[1]);

    // One post (the login, which has to happen — everything else needs a
    // token) and any number of gets. Nothing else: no put, patch, del,
    // request, or batch.
    expect(calls.filter((verb) => verb === 'post')).toHaveLength(1);
    expect(calls.filter((verb) => !['get', 'post'].includes(verb))).toEqual([]);
  });

  it('sends its one post only to the login endpoint', () => {
    const post = code.match(/http\.post\(\s*`?([^`,'")]*)/);
    expect(post?.[1]).toContain('/auth/login');
  });

  it('does not reach for k6\'s generic request builders, which hide the verb', () => {
    // `http.request('POST', …)` and `http.batch([...])` would both satisfy a
    // naive verb check while sending writes.
    expect(code).not.toMatch(/\bhttp\.request\b/);
    expect(code).not.toMatch(/\bhttp\.batch\b/);
  });
});

describe('SAP-backed reads stay behind a flag', () => {
  it('gates every sap-status read on INCLUDE_SAP', () => {
    // Hammering a customer's SAP gateway trips their circuit breaker and
    // takes the portal down for everyone on that tenant.
    const sapReads = [...code.matchAll(/'(\/[^']*sap-status[^']*)'/g)].map((match) => match[1]);
    expect(sapReads.length).toBeGreaterThan(0);

    for (const path of sapReads) {
      const index = code.indexOf(path);
      // The nearest preceding INCLUDE_SAP guard, with no intervening
      // group/function boundary that would put the read outside it.
      const before = code.slice(0, index);
      const guard = before.lastIndexOf('INCLUDE_SAP');
      expect([path, guard]).not.toEqual([path, -1]);
      // And nothing closes the guarded block between the two.
      expect(before.slice(guard)).not.toContain('export function');
    }
  });

  it('defaults INCLUDE_SAP to off', () => {
    expect(code).toMatch(/INCLUDE_SAP\s*=\s*String\(__ENV\.INCLUDE_SAP\s*\|\|\s*''\)/);
  });
});

describe('a rate-limited run cannot read as a fast one', () => {
  // A 429 is quick, so without this a run that measured express-rate-limit
  // would look better than an honest one.
  it('tracks 429s as their own metric', () => {
    expect(code).toContain("new Rate('rate_limited')");
    expect(code).toMatch(/rateLimited\.add\(res\.status === 429\)/);
  });

  it('fails the run when rate limiting is hit', () => {
    expect(code).toMatch(/rate_limited:\s*\['rate<0\.01'\]/);
  });
});

describe('the runbook is reachable', () => {
  it('is listed in the runbooks index', () => {
    const index = readFileSync(join(process.cwd(), 'docs', 'runbooks', 'README.md'), 'utf8');
    expect(index).toContain('load-testing.md');
  });

  it('warns about the rate limits, SAP and the target environment', () => {
    // Collapsed, because prose is hard-wrapped at 80 columns and a phrase
    // that happens to straddle a line break is still present.
    const runbook = readFileSync(join(process.cwd(), 'docs', 'runbooks', 'load-testing.md'), 'utf8')
      .replace(/\s+/g, ' ');

    expect(runbook).toContain('API_RATE_LIMIT_MAX');
    expect(runbook).toContain('TENANT_RATE_LIMIT_MAX');
    expect(runbook).toContain('circuit breaker');
    expect(runbook).toMatch(/not production/i);
  });
});
