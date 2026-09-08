// Replaces the Mongoose instance method Client.prototype.isOperational()
// (models/Client.js) now that Client is a plain Prisma row, not a document
// with methods. Same rule: only Trial and Active tenants may authenticate or
// transact.
const isClientOperational = (client) =>
  !!client && (client.status === 'Trial' || client.status === 'Active');

module.exports = { isClientOperational };
