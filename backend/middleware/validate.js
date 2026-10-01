const validate = (schema) => Object.assign((req, res, next) => {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    const errors = result.error.issues.reduce((acc, e) => {
      acc[e.path.join('.')] = e.message;
      return acc;
    }, {});
    return res.status(400).json({ success: false, errors });
  }
  req.body = result.data; // use coerced/cleaned data
  next();
}, { bodySchema: schema }); // exposed so a route-table test can see which schema a route is guarded by

module.exports = validate;
