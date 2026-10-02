const { purgeSapLogs } = require('../retention');

// Retention (issue #128). Takes no adapter: this only touches our own database.
module.exports = async ({ job }) => {
  await purgeSapLogs({ clientId: job.clientId });
  return { done: true };
};
