const { notImplementedDriver, assertImplements } = require('../contract');

// S/4HANA via the OData APIs (API_BUSINESS_PARTNER, API_PURCHASEORDER_PROCESS_SRV,
// API_SUPPLIERINVOICE_PROCESS_SRV, …).
//
// A skeleton on purpose. Phase 8 fills it in against a design partner's
// sandbox; until then every method throws `not_implemented` rather than
// pretending, so a tenant configured onto this driver fails loudly and
// immediately instead of silently behaving like the mock. `testConnection` is
// the one exception below — it is implemented far enough to tell an operator
// whether the host is reachable at all, which is the first thing they will want
// during onboarding.

const createS4ODataDriver = ({ config = {}, secrets = {} } = {}) => {
  const driver = {
    ...notImplementedDriver('s4_odata'),
    name: 's4_odata',

    // Reachability only: a 401 from the gateway still proves the host exists
    // and answers, which is a different problem from a wrong hostname, and an
    // operator debugging onboarding needs to tell the two apart.
    testConnection: async () => {
      const started = Date.now();
      const base = String(config.baseUrl || '').replace(/\/$/, '');
      const url = `${base}${config.pingPath || '/sap/opu/odata/sap/API_BUSINESS_PARTNER/$metadata'}`;

      const headers = { Accept: 'application/xml' };
      if (secrets.username && secrets.password) {
        headers.Authorization = `Basic ${Buffer.from(`${secrets.username}:${secrets.password}`).toString('base64')}`;
      }
      if (config.sapClient) headers['sap-client'] = String(config.sapClient);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Number(config.timeoutMs) || 10000);

      try {
        const response = await fetch(url, { headers, signal: controller.signal });
        return {
          data: {
            ok: response.ok,
            message: response.ok
              ? `Gateway answered ${response.status}`
              : `Gateway answered ${response.status} ${response.statusText} — the host is reachable but the request was refused`,
            latencyMs: Date.now() - started,
            detail: { status: response.status, url },
          },
        };
      } catch (error) {
        return {
          data: {
            ok: false,
            message: error.name === 'AbortError' ? 'Timed out waiting for the gateway' : `Could not reach the gateway: ${error.message}`,
            latencyMs: Date.now() - started,
            detail: { url },
          },
        };
      } finally {
        clearTimeout(timeout);
      }
    },

    health: async () => ({ data: { status: 'unknown', detail: { reason: 'driver not implemented' } } }),
  };

  return assertImplements(driver, 's4_odata');
};

const validateConfig = (config = {}) => {
  const errors = {};
  if (!config.baseUrl) errors.baseUrl = 'A gateway base URL is required';
  else if (!/^https?:\/\//i.test(config.baseUrl)) errors.baseUrl = 'Must be an http(s) URL';
  if (!config.sapClient) errors.sapClient = 'An SAP client number is required (e.g. 100)';
  return errors;
};

module.exports = {
  createS4ODataDriver,
  validateConfig,
  secretFields: [
    { name: 'username', label: 'Technical user' },
    { name: 'password', label: 'Password' },
  ],
  configFields: [
    { name: 'baseUrl', label: 'Gateway base URL', type: 'text', placeholder: 'https://my-s4.example.com' },
    { name: 'sapClient', label: 'SAP client', type: 'text', placeholder: '100' },
    { name: 'timeoutMs', label: 'Request timeout (ms)', type: 'number', default: 10000 },
  ],
};
