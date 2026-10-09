const fs = require('fs');
const path = require('path');
const { METHOD_NAMES, SAP_METHODS } = require('../sap/contract');

// Every driver method that issues a mutating HTTP request to SAP has to be
// classified, and this is what refuses to let a new one through unclassified.
//
// `sap/conformance/runner.js` skips a contract method flagged `createsDocument`
// or `changesMasterData` and runs everything else for real -- against whatever
// connection `scripts/sap-conformance.js --client <id>` resolves, which is a
// live SAP. The flags are therefore a safety boundary, and until a go-live QA
// pass they were set on two methods out of five: `vendorCreate` POSTs to
// `zvendor_create/VENDOR_CR` unconditionally, so a conformance run against a
// real system created a vendor master -- named after the fixture, consuming a
// number from a real range -- once per run.
//
// tests/sap-conformance.test.js could not have caught that: it derives its
// `skippable` list from the same flags it then checks, so it proves the skip
// mechanism works and is blind to a method missing from the set. This file
// checks the set itself, against the drivers' actual source.
//
// Two categories, both deliberate (see contract.js's note on poAssetCreate):
//
//   * SKIPPED -- brings something new into existence in SAP. Each run consumes
//     a number range and leaves a record behind, so it can never be exercised.
//   * EXERCISED -- changes a document SAP already owns, and can be run twice
//     harmlessly. Left reachable on purpose: these are the only methods whose
//     request-building and response-parsing a conformance run against a real
//     gateway actually proves.
//
// A new write lands in neither list, and this file fails until someone decides
// which it is. That decision is the point; the test only insists it be made.

const DRIVER_DIR = path.join(__dirname, '..', 'sap', 'drivers');

// Writes deliberately left exercisable, with the reason each is considered
// repeatable. Adding a name here is the decision this file exists to force --
// it should be a conscious edit with a comment, not a way to quiet a failure.
const EXERCISED_WRITES = {
  poAcknowledge: 'PATCHes an acknowledgement flag SAP already holds, and only when config.fields.poAcknowledgeField is set',
  quotationUpdatePrice: 'sets the net price on a quotation SAP already holds; re-sending the same price is a no-op',
  poInvoicePlanUpdate: 'replaces the invoicing plan on a PO line SAP already holds; the same plan re-sent is the same plan',
};

const MUTATING_VERBS = ['POST', 'PUT', 'PATCH', 'DELETE'];

// Driver methods are declared as `    <name>: async (`/`    <name>: async {`
// at one indent inside the returned object. A method's body runs to the next
// such declaration.
const DECLARATION = /^ {4}([a-zA-Z][a-zA-Z0-9]*): async/;

const driverFiles = () => fs.readdirSync(DRIVER_DIR)
  .filter((name) => name.endsWith('.driver.js'))
  .map((name) => path.join(DRIVER_DIR, name));

/** Every `{ method, mutating }` the driver sources declare, for contract methods only. */
const scanDrivers = () => {
  const found = [];

  for (const file of driverFiles()) {
    const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');

    const starts = [];
    lines.forEach((line, index) => {
      const match = line.match(DECLARATION);
      if (match) starts.push({ method: match[1], index });
    });

    starts.forEach(({ method, index }, position) => {
      const end = position + 1 < starts.length ? starts[position + 1].index : lines.length;
      const body = lines.slice(index, end).join('\n');
      // The shape every call site in these drivers uses, whether it goes
      // through `odata.call({ method: 'PATCH' })` or `abortableFetch(url, {
      // method: 'POST' })`.
      const mutating = MUTATING_VERBS.some((verb) => body.includes(`method: '${verb}'`));
      found.push({ file: path.basename(file), method, mutating });
    });
  }

  return found.filter(({ method }) => METHOD_NAMES.includes(method));
};

const isSkipped = (method) =>
  Boolean(SAP_METHODS[method].createsDocument || SAP_METHODS[method].changesMasterData);

describe('SAP driver write methods are classified for the conformance runner', () => {
  // Guards the scanner itself. If DECLARATION stops matching -- a reformat, a
  // different declaration style, a driver that builds its object another way --
  // every assertion below passes vacuously on an empty list, which is the
  // failure mode this whole file exists to prevent. So assert the scan found
  // the shape it expects before trusting anything it reports.
  it('finds the driver methods it means to scan', () => {
    const scanned = scanDrivers();

    expect(scanned.length).toBeGreaterThanOrEqual(15);
    // vendorCreate is the known-mutating anchor: it POSTs to VENDOR_CR. If the
    // scanner cannot see that, it cannot see anything.
    expect(scanned).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'vendorCreate', mutating: true }),
    ]));
    // ...and a known read must NOT read as mutating, or the verb match is
    // catching something other than a request.
    expect(scanned.filter((m) => m.method === 'vendorPoGrnDisplay').every((m) => !m.mutating)).toBe(true);
  });

  it('flags every mutating method as skipped, or names it as a deliberate exercised write', () => {
    const unclassified = scanDrivers()
      .filter(({ method, mutating }) => mutating
        && !isSkipped(method)
        && !Object.hasOwn(EXERCISED_WRITES, method))
      .map(({ file, method }) => `${method} (${file})`);

    // A name here means: this driver method writes to SAP, the conformance
    // runner will call it against a live system, and nobody has said that is
    // safe. Either flag it in sap/contract.js (createsDocument /
    // changesMasterData) or add it to EXERCISED_WRITES above with the reason it
    // is repeatable.
    expect(unclassified).toEqual([]);
  });

  it('does not keep a method in EXERCISED_WRITES once the contract flags it unsafe', () => {
    // The two lists must not overlap: a flagged method is never exercised, so
    // leaving it here would state a reason that no longer applies and hide the
    // next real entry among stale ones.
    const contradictory = Object.keys(EXERCISED_WRITES).filter(isSkipped);
    expect(contradictory).toEqual([]);
  });

  it('does not list a method in EXERCISED_WRITES that no driver actually writes with', () => {
    // Keeps the allowlist honest in the other direction: an entry that stopped
    // being a write -- endpoint withdrawn, method reimplemented as a read -- is
    // a standing exemption for nothing, and the next person reads it as
    // evidence that writes here are fine.
    const mutating = new Set(scanDrivers().filter((m) => m.mutating).map((m) => m.method));
    const stale = Object.keys(EXERCISED_WRITES).filter((method) => !mutating.has(method));
    expect(stale).toEqual([]);
  });

  it('skips both methods that bring something new into existence in SAP', () => {
    // The distinction contract.js draws, asserted rather than left to the
    // comment: consuming a number range is what makes a write unrepeatable.
    expect(isSkipped('vendorCreate')).toBe(true);
    expect(isSkipped('poAssetCreate')).toBe(true);
  });
});
