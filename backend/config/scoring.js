// Defaults for the ME48 weighted bid evaluation.
//
// These used to be inlined as bare 80s and 7s at four call sites across
// submitBid and getEvaluationMatrix, and they had already diverged: an
// auto-created invitation stamped `rating: 95` while an invitation made by a
// buyer with no explicit rating fell back to 80 — so a supplier who was never
// invited scored 1.5 weighted points above one who was, on identical bids.
//
// A default is only fair if it is the *same* default everywhere, so there is
// one of each here and no literal anywhere else.

// Applied when an invitation carries no rating, and again when reading a bid
// whose vendorRating was never set.
const DEFAULT_VENDOR_RATING = 80;

// No technical evaluation is captured through the portal yet; every bid gets
// the same score, so this term is currently constant across a tender and
// cancels out of the ranking.
const DEFAULT_TECHNICAL_SCORE = 80;

// Used when a bid names no lead time, both on write and when scoring.
const DEFAULT_LEAD_TIME_DAYS = 7;

module.exports = {
  DEFAULT_VENDOR_RATING,
  DEFAULT_TECHNICAL_SCORE,
  DEFAULT_LEAD_TIME_DAYS,
};
