const { z } = require('zod');

// The key -> value shape of a settings patch is checked per key against the
// registry in config/tenantSettings.js (applySettings), which knows each
// setting's own type and range. This only fixes the envelope: one `settings`
// object and nothing beside it.
const settingsPatchSchema = z.strictObject({
  settings: z.record(z.string(), z.any()),
});

module.exports = { settingsPatchSchema };
