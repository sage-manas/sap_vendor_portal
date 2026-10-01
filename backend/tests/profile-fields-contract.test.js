const { profileUpdateSchema } = require('../validators/vendor.validator');
const { PROFILE_WRITABLE_FIELDS } = require('./helpers');

// The supplier form holds the whole GET /vendors/profile response and narrows
// it to the columns below before PUTting it (src/features/profile/profileFields.js).
// The API refuses any key it does not declare, so a name on that list that the
// schema lacks would turn every profile save into a 400 — and the form swallows
// that error. Read the list out of the frontend file rather than restating it.

const frontendFields = PROFILE_WRITABLE_FIELDS;

describe('the profile form and PUT /vendors/profile agree on the field list', () => {
  it('reads the frontend list', () => {
    expect(frontendFields.length).toBeGreaterThan(20);
  });

  it('every field the form sends is one the schema declares', () => {
    const declared = Object.keys(profileUpdateSchema.shape);
    expect(frontendFields.filter((field) => !declared.includes(field))).toEqual([]);
  });

  it('every field the schema declares can be sent by the form', () => {
    const declared = Object.keys(profileUpdateSchema.shape);
    expect(declared.filter((field) => !frontendFields.includes(field))).toEqual([]);
  });
});
