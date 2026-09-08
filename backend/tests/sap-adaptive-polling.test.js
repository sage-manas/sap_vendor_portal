// jobs/adaptivePolling.js — Phase 4.3 of docs/04-sap-runtime-engineering-plan.md.
const { laneFor, intervalFor, nextRunAt, nextQuietTicks, LANES } = require('../jobs/adaptivePolling');

describe('laneFor', () => {
  it('an open watch always means fast, regardless of anything else', () => {
    expect(laneFor({ hasOpenWatch: true, activeWithinLastHour: false, hasOpenCommercialDocument: false })).toBe('fast');
  });

  it('recent activity with no open watch is still fast', () => {
    expect(laneFor({ hasOpenWatch: false, activeWithinLastHour: true, hasOpenCommercialDocument: false })).toBe('fast');
  });

  it('an open PO or unpaid invoice with no watch or recent activity is normal', () => {
    expect(laneFor({ hasOpenWatch: false, activeWithinLastHour: false, hasOpenCommercialDocument: true })).toBe('normal');
  });

  it('nothing going on is slow', () => {
    expect(laneFor({ hasOpenWatch: false, activeWithinLastHour: false, hasOpenCommercialDocument: false })).toBe('slow');
  });
});

describe('intervalFor', () => {
  it('starts at the lane\'s base interval when quietTicks is 0', () => {
    // Jitter is +/-10%, so assert a range rather than an exact value.
    const ms = intervalFor('fast', 0);
    expect(ms).toBeGreaterThanOrEqual(LANES.fast.baseMs * 0.9);
    expect(ms).toBeLessThanOrEqual(LANES.fast.baseMs * 1.1);
  });

  it('backs off as quietTicks grows, capped at the lane\'s own ceiling', () => {
    const early = intervalFor('slow', 0);
    const later = intervalFor('slow', 3);
    const capped = intervalFor('slow', 20); // far past the doubling ceiling

    expect(later).toBeGreaterThan(early);
    expect(capped).toBeLessThanOrEqual(LANES.slow.capMs * 1.1);
  });

  it('never exceeds the lane\'s cap even at very high quietTicks', () => {
    for (const lane of ['fast', 'normal', 'slow']) {
      const ms = intervalFor(lane, 1000);
      expect(ms).toBeLessThanOrEqual(LANES[lane].capMs * 1.1);
    }
  });

  it('a faster lane never produces a slower interval than a slower lane at the same quietTicks', () => {
    // Compare ceilings directly (jitter makes a single sample noisy) — the
    // real guarantee is the lanes don't overlap in *capacity*, not that any
    // one draw is ordered.
    expect(LANES.fast.capMs).toBeLessThan(LANES.normal.baseMs);
    expect(LANES.normal.capMs).toBeLessThan(LANES.slow.baseMs);
  });
});

describe('nextRunAt', () => {
  it('returns a Date strictly after now', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const result = nextRunAt('fast', 0, now);
    expect(result.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe('nextQuietTicks', () => {
  it('resets to zero on any change', () => {
    expect(nextQuietTicks(7, { changed: true })).toBe(0);
  });

  it('increments by one when nothing changed', () => {
    expect(nextQuietTicks(3, { changed: false })).toBe(4);
  });

  it('starts from zero when no current value is given', () => {
    expect(nextQuietTicks(undefined, { changed: false })).toBe(1);
  });
});
