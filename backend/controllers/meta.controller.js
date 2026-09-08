const { SAP_FIELDS, UOM_TO_ISO } = require('../sap/mappings/fields');
const asyncHandler = require('../utils/asyncHandler');

// @desc    SAP field limits and the unit-of-measure catalogue, so a form's
//          maxLength/unit dropdown is read from the same registry the backend
//          enforces (sap/mappings/fields.js) rather than a second, driftable
//          copy in the frontend — same pattern as /workspace/settings.
// @route   GET /api/meta/sap-fields
// @access  Public — a set of field limits and unit codes, not sensitive.
const getSapFields = asyncHandler(async (req, res) => {
  const fields = Object.fromEntries(
    Object.entries(SAP_FIELDS).map(([key, spec]) => [key, { max: spec.max, label: spec.label }]),
  );

  // Options as { value, label } for a <select>: the ISO code SAP_FIELDS.MEINS
  // will encode, and the friendliest input string that maps to it (deduped —
  // several free-text spellings share one ISO code).
  const seen = new Set();
  const units = [];
  for (const [input, iso] of Object.entries(UOM_TO_ISO)) {
    if (seen.has(iso)) continue;
    seen.add(iso);
    units.push({ value: iso, label: input.charAt(0).toUpperCase() + input.slice(1) });
  }

  res.json({ fields, units });
});

module.exports = { getSapFields };
