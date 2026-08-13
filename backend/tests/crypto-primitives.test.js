// The two primitives the platform plane's security rests on: the TOTP
// implementation behind mandatory MFA, and the authenticated encryption that
// stores its secret. Both are hand-rolled on node's crypto, so both are tested
// against their specifications rather than only through the API.
const totp = require('../utils/totp');
const { encrypt, decrypt, isEncrypted } = require('../utils/secretBox');

describe('totp', () => {
  // RFC 6238 Appendix B, SHA-1 vectors. The published seed is the ASCII string
  // "12345678901234567890"; base32 of that is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches the RFC 6238 vector at t=%i', (seconds, expected) => {
    expect(totp.generateToken(RFC_SECRET, seconds * 1000)).toBe(expected);
  });

  it('accepts one step of drift either way and nothing further', () => {
    const secret = totp.generateSecret();
    const now = Date.now();
    const step = totp.STEP_SECONDS * 1000;

    expect(totp.verifyToken(secret, totp.generateToken(secret, now), now)).toBe(true);
    expect(totp.verifyToken(secret, totp.generateToken(secret, now - step), now)).toBe(true);
    expect(totp.verifyToken(secret, totp.generateToken(secret, now + step), now)).toBe(true);
    expect(totp.verifyToken(secret, totp.generateToken(secret, now - 2 * step), now)).toBe(false);
    expect(totp.verifyToken(secret, totp.generateToken(secret, now + 2 * step), now)).toBe(false);
  });

  it('rejects malformed input rather than throwing', () => {
    const secret = totp.generateSecret();
    for (const bad of ['', null, undefined, '12345', '1234567', 'abcdef', {}]) {
      expect(totp.verifyToken(secret, bad)).toBe(false);
    }
    expect(totp.verifyToken(null, '123456')).toBe(false);
  });

  it('generates a distinct secret each time, and an otpauth URI an app can read', () => {
    const secret = totp.generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(secret).not.toBe(totp.generateSecret());

    const url = totp.otpauthUrl({ secret, account: 'ops@example.com' });
    expect(url).toContain('otpauth://totp/VendorConnect:ops%40example.com');
    expect(url).toContain(`secret=${secret}`);
  });
});

describe('secretBox', () => {
  it('round-trips, and produces different ciphertext every time', () => {
    const plaintext = 'JBSWY3DPEHPK3PXP';
    const first = encrypt(plaintext);
    const second = encrypt(plaintext);

    expect(first).not.toBe(second);          // random IV per message
    expect(first).not.toContain(plaintext);
    expect(isEncrypted(first)).toBe(true);
    expect(decrypt(first)).toBe(plaintext);
    expect(decrypt(second)).toBe(plaintext);
  });

  it('refuses tampered ciphertext instead of returning something plausible', () => {
    const envelope = encrypt('sensitive');
    const [version, iv, tag, ciphertext] = envelope.split(':');

    expect(() => decrypt([version, iv, tag, `${ciphertext.slice(0, -2)}AA`].join(':'))).toThrow();
    expect(() => decrypt('v1:garbage')).toThrow(/unrecognised ciphertext envelope/);
    expect(() => decrypt('plaintext-that-was-never-encrypted')).toThrow(/unrecognised ciphertext envelope/);
  });

  it('treats an absent secret as absent, not as an error', () => {
    expect(encrypt(null)).toBeNull();
    expect(encrypt('')).toBeNull();
    expect(decrypt(null)).toBeNull();
  });
});
