const { METHOD_NAMES } = require('./contract');

// How long one SAP call may take, per endpoint.
//
// Before this, every call in s4odata.driver.js read the same
// `Number(config.timeoutMs) || 10000`, with exactly one exception —
// `poGrnTimeoutMs`, added because zpo_grn_vendor/Detail was observed taking
// 22–84s for ~170 orders and a 10s ceiling made it permanently unusable. That
// exception is the evidence the single shared ceiling was wrong: SAP's
// endpoints do not share a latency profile, and one number has to be either
// too tight for the slowest or too slack for the rest. Too slack is not free —
// a 120s ceiling on every read is 120s of a held connection and a user staring
// at a spinner before the circuit breaker learns anything.
//
// What this does NOT do is invent per-endpoint figures. The only endpoint this
// project has measured is the PO/GRN detail one, and its number is below with
// the observation that produced it. Everything else resolves to the shared
// `timeoutMs`, exactly as before — the change is that an operator who measures
// a slow endpoint can now raise *that* one, instead of raising the ceiling for
// every call or waiting for a code change.

// A per-method default, only where a real observation exists. An entry here is
// a measurement, not a guess; add one when you have a number, and say where it
// came from.
const METHOD_DEFAULTS = {
  // 22–84s observed against the live sandbox for ~170 orders. The Z endpoint
  // has no filter of its own, so every call returns the vendor's entire
  // PO/GRN history (see the driver's own note, and the TtlCache in
  // po.controller.js that exists to avoid paying this twice).
  vendorPoGrnDisplay: 120000,
};

// The shared ceiling, unchanged: what every unmeasured endpoint still gets.
const DEFAULT_TIMEOUT_MS = 10000;

// `poGrnTimeoutMs` predates this module and is already set on live tenant
// connections, so it keeps working rather than being quietly ignored at the
// moment someone's slowest endpoint starts timing out again.
const LEGACY_KEYS = {
  vendorPoGrnDisplay: 'poGrnTimeoutMs',
};

// A positive finite number, or undefined. A config field arrives as whatever
// was typed into the connection form, so '' , null, 'abc' and 0 all have to
// mean "not set" rather than "no time at all".
const positive = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const configKeyFor = (method) => `${method}TimeoutMs`;

/**
 * The timeout for one SAP method, in milliseconds.
 *
 * Resolution order, most specific first:
 *   1. `config.<method>TimeoutMs`      — this tenant, this endpoint
 *   2. the legacy key, where one exists (`poGrnTimeoutMs`)
 *   3. METHOD_DEFAULTS[method]         — a measured default
 *   4. `config.timeoutMs`              — this tenant, every endpoint
 *   5. DEFAULT_TIMEOUT_MS
 */
const timeoutFor = (method, config = {}) => positive(config[configKeyFor(method)])
  ?? positive(LEGACY_KEYS[method] && config[LEGACY_KEYS[method]])
  ?? METHOD_DEFAULTS[method]
  ?? positive(config.timeoutMs)
  ?? DEFAULT_TIMEOUT_MS;

// The per-endpoint override fields, for a driver's `configFields`. Generated
// from the contract rather than listed, so a method added to SAP_METHODS is
// overridable the day it exists and nobody has to remember this file.
//
// `logged: false` methods are included deliberately — a catalogue read is
// still an HTTP call that can hang, and several of them are the slowest things
// here.
const timeoutConfigFields = () => METHOD_NAMES.map((method) => ({
  name: configKeyFor(method),
  label: `Timeout for ${method} (ms)${METHOD_DEFAULTS[method] ? ` — measured default ${METHOD_DEFAULTS[method]}` : ''}`,
  type: 'number',
  // No `default`: an empty field has to mean "fall through to the shared
  // timeout", and a default here would write a per-endpoint value onto every
  // connection, which is the opposite of the point.
  advanced: true,
}));

module.exports = {
  timeoutFor,
  timeoutConfigFields,
  configKeyFor,
  METHOD_DEFAULTS,
  DEFAULT_TIMEOUT_MS,
  LEGACY_KEYS,
};
