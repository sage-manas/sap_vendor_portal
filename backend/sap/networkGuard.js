const dns = require('dns');
const net = require('net');

// Where the portal is allowed to send an SAP request.
//
// The gateway base URL is configuration an operator types in, and the portal
// calls it from its own network position — inside the host's firewall, next to
// the cloud's instance-metadata service and whatever else listens on loopback
// or the private network. Without a check, "SAP gateway URL" is a way to make
// the server fetch any internal address and, through the error text and the SAP
// log viewer, read back what it said (SSRF).
//
// So the destination is checked at the moment of the call, not only when the
// connection is saved: a hostname that was public when saved can be re-pointed.
//
//   * Private, loopback, link-local, CGNAT and other non-public ranges are
//     refused.
//   * An on-premises SAP legitimately lives on a private address. The operator
//     of the *server* (not of the console) lists it in SAP_ALLOWED_PRIVATE_HOSTS
//     — exact hostnames, single IPs or CIDR ranges, comma separated.
//   * The link-local / metadata range is never allowed, whatever the list says;
//     no SAP system lives at 169.254.x.x and that is where credentials do.
//
// Residual risk, stated plainly: `fetch` resolves the name again itself, so a
// DNS record that flips between our lookup and its connection (rebinding) can
// still slip a request through. The GET-with-body call pins the address it
// validated; closing the gap for `fetch` needs a connection-level dispatcher
// (undici) the backend does not depend on today.

class SapTargetBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SapTargetBlockedError';
    this.code = 'sap_target_blocked';
  }
}

const list = (entries) => {
  const blocks = new net.BlockList();
  for (const [address, prefix, type] of entries) blocks.addSubnet(address, prefix, type);
  return blocks;
};

// Never reachable, not even by allow-list.
const NEVER = list([
  ['169.254.0.0', 16, 'ipv4'], // link-local, incl. 169.254.169.254 metadata
  ['fe80::', 10, 'ipv6'],
  ['fd00:ec2::', 32, 'ipv6'], // AWS IPv6 metadata
  ['0.0.0.0', 8, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'], // multicast
  ['240.0.0.0', 4, 'ipv4'], // reserved, incl. broadcast
  ['::', 128, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
]);

// Not public; allowed only through SAP_ALLOWED_PRIVATE_HOSTS.
const PRIVATE = list([
  ['127.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'], // carrier-grade NAT
  ['192.0.0.0', 24, 'ipv4'], // IETF protocol assignments
  ['198.18.0.0', 15, 'ipv4'], // benchmarking
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'], // unique-local
]);

const familyOf = (address) => (net.isIPv6(address) ? 'ipv6' : 'ipv4');
const inList = (blocks, address) => blocks.check(address, familyOf(address));

const parseAllowList = () => {
  const names = new Set();
  const ranges = new net.BlockList();
  String(process.env.SAP_ALLOWED_PRIVATE_HOSTS || '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean).forEach((entry) => {
    const [host, prefix, ...extra] = entry.split('/');
    if (extra.length) return;
    if (net.isIP(host)) {
      const bits = familyOf(host) === 'ipv6' ? 128 : 32;
      const length = prefix === undefined ? bits : Number(prefix);
      // 0.0.0.0/0 and friends are "allow everything"; that is not an
      // allow-list entry, it is switching the guard off.
      const floor = bits === 128 ? 32 : 8;
      if (!Number.isInteger(length) || length < floor || length > bits) return;
      ranges.addSubnet(host, length, familyOf(host));
    } else if (prefix === undefined && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) {
      names.add(host.replace(/\.$/, ''));
    }
  });
  return { names, ranges };
};

const normaliseHost = (url) => {
  let parsed;
  try { parsed = new URL(String(url).trim()); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
};

const isLocalName = (host) => host === 'localhost' || host.endsWith('.localhost');

const verdictFor = (address, { host, allow }) => {
  if (inList(NEVER, address)) return 'link-local and metadata addresses are never allowed';
  if (inList(PRIVATE, address)) {
    if (allow.names.has(host) || inList(allow.ranges, address)) return null;
    return 'it is a private or loopback address; an on-premises SAP has to be listed in SAP_ALLOWED_PRIVATE_HOSTS on the server';
  }
  return null;
};

const defaultResolver = (host) => dns.promises.lookup(host, { all: true, verbatim: true });
let resolver = defaultResolver;
const setResolver = (fn) => { resolver = fn; };
const resetResolver = () => { resolver = defaultResolver; };

const blocked = (host, reason) => new SapTargetBlockedError(`SAP target "${host}" is not allowed: ${reason}`);

/**
 * Throws SapTargetBlockedError unless `url` may be called. Resolves with the
 * addresses it validated, for a caller that can pin them.
 */
const assertSafeTarget = async (url) => {
  const host = normaliseHost(url);
  if (!host) throw new SapTargetBlockedError('SAP target is not allowed: only http(s) URLs may be called');

  const allow = parseAllowList();

  if (net.isIP(host)) {
    const reason = verdictFor(host, { host, allow });
    if (reason) throw blocked(host, reason);
    return [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  }

  if (isLocalName(host) && !allow.names.has(host)) throw blocked(host, 'it names this machine');

  let addresses;
  try {
    addresses = await resolver(host);
  } catch (error) {
    throw blocked(host, `it could not be resolved (${error.code || error.message})`);
  }
  if (!addresses?.length) throw blocked(host, 'it did not resolve to any address');

  for (const { address } of addresses) {
    const reason = verdictFor(address, { host, allow });
    if (reason) throw blocked(host, `it resolves to ${address}: ${reason}`);
  }
  return addresses;
};

/**
 * Save-time check: only what can be judged without a DNS lookup — a literal
 * address or a name for this machine. Returns a message, or null if fine.
 * Hostnames are judged again, with their real addresses, on every call.
 */
const literalTargetProblem = (baseUrl) => {
  const host = normaliseHost(baseUrl);
  if (!host) return null; // the scheme/shape checks report that
  const allow = parseAllowList();
  if (net.isIP(host)) {
    const reason = verdictFor(host, { host, allow });
    return reason ? `Not allowed: ${reason}` : null;
  }
  if (isLocalName(host) && !allow.names.has(host)) return 'Not allowed: it names this machine';
  return null;
};

module.exports = { assertSafeTarget, literalTargetProblem, setResolver, resetResolver, SapTargetBlockedError };
