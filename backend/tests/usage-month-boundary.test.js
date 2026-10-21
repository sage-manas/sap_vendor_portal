const { startOfMonth } = require('../utils/usage');

// Issue #289. `startOfMonth` was `new Date(now.getFullYear(), now.getMonth(),
// 1)` — the *server's* local calendar. So a workspace's monthly RFQ quota
// rolled over whenever the host happened to say midnight: on a UTC server,
// 05:30 IST, which means an RFQ raised at 02:00 IST on the 1st was counted
// against the month that had already ended, and the first five and a half
// hours of every month enforced the previous month's total.
//
// The answer must be a property of the tenant's timezone and nothing else —
// in particular, not of where the process runs. These assert that directly,
// by asking for an instant and checking which month it lands in.

// `now` is passed in rather than faked with timers: the function's answer is
// a function of its inputs, and saying so is the whole point.
const atIso = (iso, timeZone) => startOfMonth(timeZone, new Date(iso)).toISOString();

describe('utils/usage startOfMonth', () => {
  it('is the tenant\'s local midnight on the 1st, as a UTC instant', () => {
    // 1 Nov 2026, 00:00 IST is 31 Oct 2026, 18:30 UTC.
    expect(atIso('2026-11-10T09:00:00Z', 'Asia/Kolkata')).toBe('2026-10-31T18:30:00.000Z');
  });

  it('counts an RFQ raised just after the tenant\'s midnight into the new month', () => {
    // 02:00 IST on 1 Nov — the window the old code got wrong, because the UTC
    // server it ran on still called it October.
    const raisedAt = new Date('2026-10-31T20:30:00Z'); // 02:00 IST, 1 Nov
    const boundary = startOfMonth('Asia/Kolkata', raisedAt);

    expect(raisedAt.getTime()).toBeGreaterThanOrEqual(boundary.getTime());
    // And the boundary itself is the 1st in that zone, not the 31st.
    expect(boundary.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' })).toBe('01/11/2026');
  });

  it('gives each timezone its own boundary for the same instant', () => {
    // 1 Nov 2026, 02:00 IST is still 31 Oct in UTC and in New York, so the
    // same moment belongs to a different month depending on who is asking.
    const instant = '2026-10-31T20:30:00Z';

    expect(atIso(instant, 'Asia/Kolkata')).toBe('2026-10-31T18:30:00.000Z'); // 1 Nov IST
    expect(atIso(instant, 'UTC')).toBe('2026-10-01T00:00:00.000Z');
    expect(atIso(instant, 'America/New_York')).toBe('2026-10-01T04:00:00.000Z');
  });

  it('does not depend on the server\'s own timezone', () => {
    // The defect in one line. Whatever TZ this process was started with, the
    // answer for a given zone and instant is the same — so switching hosts
    // cannot move a tenant's quota window.
    const before = process.env.TZ;
    const answers = new Set();
    for (const tz of ['UTC', 'America/New_York', 'Asia/Kolkata']) {
      process.env.TZ = tz;
      answers.add(atIso('2026-11-10T09:00:00Z', 'Asia/Kolkata'));
    }
    process.env.TZ = before;

    expect([...answers]).toEqual(['2026-10-31T18:30:00.000Z']);
  });

  it('handles a DST transition inside the month without drifting an hour', () => {
    // US DST ends on 1 Nov 2026, so New York's offset on the 1st (-04:00, the
    // transition happens at 02:00 local) is not its offset on the 10th
    // (-05:00). Asking Intl for the date in question gets this right; adding
    // a fixed offset would land an hour out and put 00:00-01:00 on the 1st in
    // the wrong month.
    expect(atIso('2026-11-10T12:00:00Z', 'America/New_York')).toBe('2026-11-01T04:00:00.000Z');
  });

  it('falls back to the registry default rather than throwing on an unknown zone', () => {
    // A quota check is not the place to crash over a bad setting. A zone this
    // runtime does not know is read as Asia/Kolkata, the registry's default.
    expect(atIso('2026-11-10T09:00:00Z', 'Mars/Olympus_Mons'))
      .toBe(atIso('2026-11-10T09:00:00Z', 'Asia/Kolkata'));
  });

  it('defaults to the tenant-settings default when asked for no zone', () => {
    expect(startOfMonth(undefined, new Date('2026-11-10T09:00:00Z')).toISOString())
      .toBe('2026-10-31T18:30:00.000Z');
  });
});
