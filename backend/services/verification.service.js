// Verifies a vendor's declared GSTIN and PAN, either against a mocked check
// (default) or a live third-party verification API, depending on
// GSTIN_PAN_VERIFY_MOCK_MODE. This is the single source of truth for whether
// a vendor's GSTIN/PAN are considered verified — controllers must not set
// gstinVerified/panVerified any other way.

const { hasValidCheckCharacter, panOfGstin } = require('../utils/gstin');

const PAN_REGEX = /^[A-Z0-9]{5}[0-9]{4}[A-Z]{1}$/i;

const isMockMode = () => process.env.GSTIN_PAN_VERIFY_MOCK_MODE !== 'false';

// Mock check: the offline arithmetic only (utils/gstin.js). The GSTIN must
// have the right shape and check character, and the PAN must be the one
// embedded in it (GSTIN characters 3-12 are always the taxpayer's PAN), the
// same cross-check a real verification provider would perform. The validators
// refuse a bad check character on write; checking it again here covers a row
// written before they did.
const verifyMock = async (gstin, pan) => {
  const gstinValid = hasValidCheckCharacter(gstin);
  const panValid = PAN_REGEX.test(pan || '');
  const panMatchesGstin = gstinValid && panValid && panOfGstin(gstin) === pan.toUpperCase();

  return {
    provider: 'MOCK',
    gstinValid,
    panValid: panValid && panMatchesGstin,
    checkedAt: new Date().toISOString()
  };
};

const verifyLive = async (gstin, pan) => {
  const apiUrl = process.env.GSTIN_PAN_VERIFY_API_URL;
  const apiKey = process.env.GSTIN_PAN_VERIFY_API_KEY;

  if (!apiUrl || !apiKey) {
    throw new Error('GSTIN/PAN verification API is not configured (GSTIN_PAN_VERIFY_API_URL / GSTIN_PAN_VERIFY_API_KEY)');
  }

  const response = await fetch(`${apiUrl}?gstin=${encodeURIComponent(gstin)}&pan=${encodeURIComponent(pan)}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });

  if (!response.ok) {
    throw new Error(`GSTIN/PAN verification API returned status ${response.status}`);
  }

  const data = await response.json();
  return {
    provider: 'LIVE',
    gstinValid: !!data.gstinValid,
    panValid: !!data.panValid,
    checkedAt: new Date().toISOString()
  };
};

// Returns { gstinValid, panValid, provider, checkedAt } and never throws —
// a failed/misconfigured lookup is reported as unverified rather than
// crashing the caller, so approval stays blocked by default.
const verifyGstinPan = async (gstin, pan) => {
  try {
    return isMockMode() ? await verifyMock(gstin, pan) : await verifyLive(gstin, pan);
  } catch (error) {
    return {
      provider: isMockMode() ? 'MOCK' : 'LIVE',
      gstinValid: false,
      panValid: false,
      checkedAt: new Date().toISOString(),
      error: error.message
    };
  }
};

module.exports = { verifyGstinPan };
