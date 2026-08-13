const logger = require('../utils/logger');

// The billing interface. Nothing in this codebase talks to a payment
// processor directly — it asks `getBillingProvider()` for the configured one
// and calls the contract, the same seam `utils/mailer.js` uses for transport
// selection and `sap/index.js` uses for drivers.
//
// Today there is exactly one provider: `null`, which logs every call and
// answers a stub success. Wiring a real processor (Stripe, Chargebee, ...)
// later is one more entry in PROVIDERS behind BILLING_PROVIDER — nothing that
// calls this module changes.

const PROVIDERS = {
  null: {
    name: 'null',
    async onTenantCreated({ client }) {
      logger.info('billing: tenant created (no-op)', { clientId: client.clientId, plan: client.plan });
      return { ok: true, provider: 'null' };
    },
    async onTenantStatusChanged({ client, from, to }) {
      logger.info('billing: tenant status changed (no-op)', { clientId: client.clientId, from, to });
      return { ok: true, provider: 'null' };
    },
    async reportUsage({ client, usage }) {
      logger.info('billing: usage reported (no-op)', { clientId: client.clientId, usage });
      return { ok: true, provider: 'null' };
    },
  },
};

const chooseProviderName = () => process.env.BILLING_PROVIDER || 'null';

// No per-tenant selection today — every tenant bills through the same
// processor, unlike SAP where each tenant has its own connection. The
// function shape still takes nothing tenant-specific, so a future provider
// that *does* vary per tenant (a reseller, a regional processor) is a
// signature change in one place.
const getBillingProvider = () => {
  const name = chooseProviderName();
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown BILLING_PROVIDER "${name}"`);
  return provider;
};

module.exports = { getBillingProvider };
