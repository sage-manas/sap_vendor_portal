import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  allowedDevOrigins: ['*.trycloudflare.com'],
  experimental: {
    // Next's static-generation workers run prerendering in parallel, and a
    // page can occasionally fail for reasons that have nothing to do with its
    // code (issue #160: /pos and /_global-error failed prerendering twice in
    // 7 build attempts with a null-dispatcher useContext error that never
    // reproduced outside that worker parallelism). By default a build gets a
    // single attempt per page (staticGenerationRetryCount defaults to 1) and
    // prerenderEarlyExit aborts the whole build on that first failure — so a
    // one-off worker hiccup, not a real regression, can fail a deploy.
    // Retrying gives a transient failure a chance to clear before that
    // happens, the way Next already retries a page that times out.
    staticGenerationRetryCount: 3,
  },
};

export default nextConfig;
