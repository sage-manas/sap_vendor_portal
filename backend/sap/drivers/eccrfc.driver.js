const { notImplementedDriver, assertImplements } = require('../contract');

// ECC via classic RFC/BAPI.
//
// A skeleton, and further from real than the S/4 one: `node-rfc` needs the SAP
// NetWeaver RFC SDK present on the host, which is a deployment decision, not a
// npm install. The likely shape is an on-prem agent speaking to us over HTTPS
// rather than a library in this process — which is exactly why the contract
// exists: that choice can be made in Phase 8 without any controller noticing.
//
// `testConnection` does not pretend to open an RFC destination. It reports what
// it can actually check — that the configuration is complete and that no
// transport is available yet — because an operator being told "connected" by
// something that never connected is worse than being told nothing.

const createEccRfcDriver = ({ config = {} } = {}) => {
  const driver = {
    ...notImplementedDriver('ecc_rfc'),
    name: 'ecc_rfc',

    testConnection: async () => ({
      data: {
        ok: false,
        message: 'The ECC RFC driver has no transport yet — configuration is stored but cannot be verified',
        latencyMs: 0,
        detail: {
          ashost: config.ashost || null,
          sysnr: config.sysnr || null,
          reason: 'not_implemented',
        },
      },
    }),

    health: async () => ({ data: { status: 'unknown', detail: { reason: 'driver not implemented' } } }),
  };

  return assertImplements(driver, 'ecc_rfc');
};

const validateConfig = (config = {}) => {
  const errors = {};
  if (!config.ashost) errors.ashost = 'An application server host is required';
  if (!config.sysnr) errors.sysnr = 'A system number is required (e.g. 00)';
  if (!config.sapClient) errors.sapClient = 'An SAP client number is required (e.g. 100)';
  return errors;
};

module.exports = {
  createEccRfcDriver,
  validateConfig,
  secretFields: [
    { name: 'username', label: 'RFC user' },
    { name: 'password', label: 'Password' },
  ],
  configFields: [
    { name: 'ashost', label: 'Application server host', type: 'text' },
    { name: 'sysnr', label: 'System number', type: 'text', placeholder: '00' },
    { name: 'sapClient', label: 'SAP client', type: 'text', placeholder: '100' },
    { name: 'lang', label: 'Logon language', type: 'text', default: 'EN' },
  ],
};
