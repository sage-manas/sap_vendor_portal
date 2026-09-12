// The API process the E2E run drives, with the job worker inside it.
//
// Both are needed: a goods receipt is not posted by the API — submitASN
// enqueues an `awaitGoodsReceipt` job and the worker completes it, the way
// deploy/ecosystem.config.js runs vendorconnect-api and vendorconnect-jobs as
// two PM2 apps.
//
// They share a process here rather than being two Playwright webServer
// entries because a webServer needs a URL to poll and the worker has no HTTP
// surface — and because a worker spawned from globalSetup does not survive on
// Windows, where Playwright puts its children in a job object that is closed
// when setup returns. That failure is silent: the job sits at attempts: 0 and
// the purchase order simply never progresses.
require('../backend/server.js');

const worker = require('../backend/jobs/worker.js');
worker.run();
console.log('[e2e] job worker started in the API process');
