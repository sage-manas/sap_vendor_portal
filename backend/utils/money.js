// Prisma returns a Decimal-typed column (see prisma/schema.prisma's money
// field comments for which ones and why) as a decimal.js instance, not a
// plain JS number. That matters more than it looks:
//
//   - `d + 1` does STRING CONCATENATION, not addition — decimal.js's
//     `valueOf()` returns a string, and `+` falls back to concatenation
//     whenever either operand's primitive value is a string. `d * 2` and
//     `d - 1` happen to still produce the right number, because those
//     operators force numeric coercion regardless of operand type — but
//     relying on that split behavior is exactly the kind of thing that reads
//     fine, works in one test, and corrupts a total in production the day
//     someone writes `+` instead.
//   - `JSON.stringify`/`res.json` serialize a Decimal as a STRING ("11.50"),
//     not a number — every existing frontend consumer and test assertion
//     expects a number.
//
// So every arithmetic use and every API response converts explicitly with
// this, rather than leaning on `*`/`-`'s coercion or forgetting the `+` trap.
const toNumber = (value) => {
  if (value === null || value === undefined) return value;
  return typeof value === 'number' ? value : Number(value);
};

module.exports = { toNumber };
