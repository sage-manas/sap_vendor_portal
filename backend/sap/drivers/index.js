const mock = require('./mock.driver');
const s4odata = require('./s4odata.driver');
const eccrfc = require('./eccrfc.driver');

// The registry of SAP drivers. The `SapConnection` enum, the console's driver
// picker, the config validator and the factory all read this one map — adding a
// fourth driver is a single entry here plus the module it points at.
//
// `secretFields` and `configFields` are what let the console render a form for
// a driver it knows nothing else about, which is how the SAP screen stays one
// screen instead of one per driver.

const DRIVERS = {
  mock: {
    key: 'mock',
    label: 'Simulator',
    description: 'A built-in SAP that answers immediately. Demos, pilots and every test.',
    implemented: true,
    create: mock.createMockDriver,
    validateConfig: mock.validateConfig,
    secretFields: mock.secretFields,
    configFields: mock.configFields,
  },
  s4_odata: {
    key: 's4_odata',
    label: 'S/4HANA (OData)',
    description: 'S/4HANA Cloud or on-premise via the OData APIs. Connection test only so far.',
    implemented: false,
    create: s4odata.createS4ODataDriver,
    validateConfig: s4odata.validateConfig,
    secretFields: s4odata.secretFields,
    configFields: s4odata.configFields,
  },
  ecc_rfc: {
    key: 'ecc_rfc',
    label: 'ECC (RFC/BAPI)',
    description: 'Classic ECC over RFC. Configuration can be stored; no transport yet.',
    implemented: false,
    create: eccrfc.createEccRfcDriver,
    validateConfig: eccrfc.validateConfig,
    secretFields: eccrfc.secretFields,
    configFields: eccrfc.configFields,
  },
};

const DRIVER_KEYS = Object.keys(DRIVERS);
const DEFAULT_DRIVER = 'mock';

const driverDefinition = (key) => {
  const definition = DRIVERS[key];
  if (!definition) throw new Error(`Unknown SAP driver "${key}" — add it to sap/drivers/index.js`);
  return definition;
};

// What the console needs to draw the configuration form, with nothing secret in
// it: field names, not values.
const driverCatalogue = () => DRIVER_KEYS.map((key) => {
  const { create, validateConfig, ...rest } = DRIVERS[key];
  return rest;
});

module.exports = { DRIVERS, DRIVER_KEYS, DEFAULT_DRIVER, driverDefinition, driverCatalogue };
