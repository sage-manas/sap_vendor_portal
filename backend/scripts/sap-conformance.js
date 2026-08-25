/**
 * SAP driver conformance suite.
 *
 *   node scripts/sap-conformance.js --client CLT-0001
 *   node scripts/sap-conformance.js --driver s4_odata --config config.json --secrets secrets.json
 *
 * Runs every method in the SapAdapter contract (backend/sap/contract.js)
 * against a real driver and reports pass/fail per method — the check Phase 8
 * promised before a real driver goes near a tenant's production traffic.
 *
 * `--client` reads the tenant's already-configured connection (needs
 * MONGO_URI); `--driver` builds a throwaway adapter from a config/secrets
 * file, the same shape the platform console's "test connection" sends, so a
 * design partner's sandbox can be pointed at directly with no tenant set up
 * first. `config.json` / `secrets.json` are plain objects, e.g. for s4_odata:
 *
 *   { "baseUrl": "https://my-s4-sandbox.example.com", "sapClient": "100" }
 *   { "username": "RFCUSER", "password": "..." }
 *
 * Exit code 0 means every method passed; 1 means at least one failed
 * unexpectedly (`not_implemented` does not count as a failure — it is the
 * expected, honest answer from an unfinished driver).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const mongoose = require('mongoose');

// A conformance run against an unfinished driver produces mostly
// not_implemented results, and each one still tries to write a SapLog entry.
// Mongoose's default is to buffer that write and wait out a 10s timeout
// before giving up when there is no live connection — turning an
// instantaneous run into minutes. Disabling buffering makes an unconnected
// write reject immediately instead, which recordSapCall already treats as a
// non-fatal, logged failure.
mongoose.set('bufferCommands', false);

const { runConformanceSuite } = require('../sap/conformance/runner');
const { getSapAdapterForClient, buildTransientAdapter } = require('../sap');
const { DRIVER_KEYS } = require('../sap/drivers');
const { METHOD_NAMES } = require('../sap/contract');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const readJson = (file) => {
  if (!file) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const usage = () => {
  console.error('Usage: node scripts/sap-conformance.js --client <clientId>');
  console.error(`   or: node scripts/sap-conformance.js --driver <${DRIVER_KEYS.join('|')}> [--config file.json] [--secrets file.json]`);
};

async function main() {
  const clientId = flag('client');
  const driverKey = flag('driver');

  if (!clientId && !driverKey) {
    usage();
    process.exitCode = 1;
    return;
  }
  if (driverKey && !DRIVER_KEYS.includes(driverKey)) {
    console.error(`Unknown driver "${driverKey}" — known drivers: ${DRIVER_KEYS.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  if (clientId && !process.env.MONGO_URI) throw new Error('MONGO_URI is required to look up a tenant connection');

  // A --driver run works without a database — SapLog writes just fail fast
  // and are reported as a logger warning, not a driver failure — but connect
  // when a MONGO_URI is available so this run's SapLog entries land somewhere
  // inspectable afterwards.
  let connected = false;
  if (process.env.MONGO_URI) {
    await mongoose.connect(process.env.MONGO_URI);
    connected = true;
  } else {
    console.log('No MONGO_URI — running without a database; SapLog writes for this run will not be persisted.');
  }

  const adapter = clientId
    ? await getSapAdapterForClient(clientId)
    : buildTransientAdapter({
      clientId: 'CONFORMANCE',
      driver: driverKey,
      secrets: readJson(flag('secrets')),
      config: {
        // The circuit breaker trips after 5 consecutive failures by default —
        // right in the middle of a run against an unfinished driver, which
        // would mask everything after method 5 behind `sap_circuit_open`
        // instead of the honest `not_implemented`. Raised here, for this run
        // only; a real tenant's connection keeps whatever threshold its
        // owner configured. Override by putting `"breaker": {...}` in
        // --config yourself.
        breaker: { failureThreshold: METHOD_NAMES.length + 1 },
        ...readJson(flag('config')),
      },
    });

  if (clientId) {
    console.log(`Note: this tenant's own breaker threshold applies (not overridden) — a run against an `
      + 'unfinished or flaky driver can trip it and report sap_circuit_open for later methods.');
  }

  console.log(`Running the conformance suite against driver "${adapter.driver}" (implemented: ${adapter.implemented})...`);

  const report = await runConformanceSuite({ adapter, clientId: clientId || 'CONFORMANCE' });

  console.table(report.results.map((r) => ({
    method: r.method,
    transaction: r.transaction || '—',
    status: r.status,
    ms: r.durationMs,
    detail: r.error || (r.data && (r.data.message || r.data.ok !== undefined ? r.data.message || r.data.ok : '')) || '',
  })));

  console.log('Summary:', report.summary);

  if (connected) await mongoose.disconnect();

  process.exitCode = report.summary.failed ? 1 : 0;
}

main().catch((error) => {
  console.error('Conformance suite errored:', error);
  process.exitCode = 1;
});
