// Sibling to validate.js, for req.query instead of req.body — the two
// cannot share one middleware because the field they read and reassign
// differs. Safe to reassign req.query here the same way validate.js
// reassigns req.body: server.js redefines req.query as a plain writable own
// property early in the middleware chain (Express 5 made it a getter with
// no setter by default), specifically so something downstream — this,
// originally the mongo-sanitizer — can rewrite it in place.
const validateQuery = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    const errors = result.error.issues.reduce((acc, e) => {
      acc[e.path.join('.')] = e.message;
      return acc;
    }, {});
    return res.status(400).json({ success: false, errors });
  }
  req.query = result.data; // use coerced/cleaned data
  next();
};

module.exports = validateQuery;
