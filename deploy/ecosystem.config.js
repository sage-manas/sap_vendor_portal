// PM2 process manager config. Keeps both Node processes alive across crashes
// and reboots. Run from the repo root: pm2 start deploy/ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'vendorconnect-api',
      cwd: __dirname + '/../backend',
      script: 'server.js',
      instances: 1,
      // Socket.io still wants sticky sessions, so this stays fork-mode — but
      // that's the only reason now. Before the SAP job runtime (jobs/worker.js)
      // existed, this pin was also load-bearing for SAP correctness: the mock
      // and s4_odata drivers' deferred answers lived in in-process
      // setTimeout()s, so two API instances meant two timers per ASN/invoice
      // and a real risk of double-persisting a GRN or payment. That work now
      // lives in durable SapJob rows claimed with `FOR UPDATE SKIP LOCKED`
      // (jobs/queue.js), so N API instances would no longer double-process
      // anything — don't switch to cluster mode without a sticky-session
      // adapter, but the SAP reason is gone.
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '400M',
      out_file: __dirname + '/../backend/logs/pm2-out.log',
      error_file: __dirname + '/../backend/logs/pm2-error.log',
      time: true,
    },
    {
      // The SAP job worker (docs/04-sap-runtime-engineering-plan.md Phase 1).
      // Runs jobs/worker.js's poll loop, claiming SapJob rows and driving
      // deferred SAP answers (goods receipt, payment run) to completion. Kept
      // out of vendorconnect-api deliberately — a slow SAP call must never
      // occupy the event loop that serves supplier requests.
      name: 'vendorconnect-jobs',
      cwd: __dirname + '/../backend',
      script: 'jobs/worker.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        JOBS_ENABLED: 'true',
      },
      max_memory_restart: '400M',
      out_file: __dirname + '/../backend/logs/pm2-jobs-out.log',
      error_file: __dirname + '/../backend/logs/pm2-jobs-error.log',
      time: true,
    },
    {
      name: 'vendorconnect-web',
      cwd: __dirname + '/..',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '400M',
      out_file: __dirname + '/../logs/pm2-web-out.log',
      error_file: __dirname + '/../logs/pm2-web-error.log',
      time: true,
    },
  ],
};
