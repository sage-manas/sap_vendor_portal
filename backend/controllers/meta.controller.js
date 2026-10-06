const { SAP_FIELDS, UOM_TO_ISO } = require('../sap/mappings/fields');
const asyncHandler = require('../utils/asyncHandler');
const { INDIAN_STATES } = require('../config/indianStates');

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

// @desc    The Indian states and union territories a GST registration can
//          belong to — the vocabulary both a supplier's own state and a
//          tenant's `Client.state` are drawn from (finding 4.4).
//
//          Served rather than duplicated in the frontend for the same reason
//          getSapFields is: services/gst.service.js decides CGST+SGST versus
//          IGST by comparing the two states as strings, so a second copy that
//          drifts on one spelling splits every invoice between those two
//          parties the wrong way, silently. config/indianStates.js is the one
//          registry; this is how a form reads it.
// @route   GET /api/meta/indian-states
// @access  Public — a list of state names, not sensitive.
const getIndianStates = asyncHandler(async (req, res) => {
  // `gstCode` is deliberately not exposed: it exists to cross-check a GSTIN
  // against a state on the server, and a form has no use for it.
  res.json({
    states: INDIAN_STATES.map(({ code, name }) => ({ code, name })),
  });
});

module.exports = { getSapFields, getIndianStates };
