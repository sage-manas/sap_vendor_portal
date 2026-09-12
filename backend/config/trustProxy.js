// Behind nginx (see deploy/nginx.conf) the socket peer is always the proxy.
// Without this, req.ip is 127.0.0.1 for every client: the per-IP rate limiter
// degrades to one global bucket, audit rows record the proxy rather than the
// actor, and restrictToLoopback in routes/internal.routes.js passes for
// proxied external callers.
//
// Never `true` — trusting every hop lets a client spoof X-Forwarded-For and
// pick its own rate-limit bucket, or forge the origin recorded in the audit
// trail. 'loopback' trusts only a proxy on this host, which is what the
// shipped deployment runs; TRUST_PROXY_HOPS overrides it with a hop count for
// deployments that sit behind an additional load balancer.
const trustProxy = () => (
  process.env.TRUST_PROXY_HOPS ? Number(process.env.TRUST_PROXY_HOPS) : 'loopback'
);

module.exports = trustProxy;
