const { purgeFinishedJobs } = require('../retention');

// Retention (issue #128). Finished jobs only: the job running this one is
// `running`, so it is never among what it deletes.
module.exports = async ({ job }) => {
  await purgeFinishedJobs({ clientId: job.clientId });
  return { done: true };
};
