# Key rotation

Two secrets, two different blast radii if they leak, two different rotation
procedures.

## `JWT_SECRET`

Signs every session token (tenant, supplier, platform).

**Rotating it invalidates every session immediately** — there is no dual-key
verification window in `utils/authToken.js`. Everyone signed in gets a 401 on
their next request and has to sign in again. There is no way around this
without adding multi-key verification, which does not exist today.

1. Pick a maintenance window; this is felt by every user of every tenant at once.
2. Set the new `JWT_SECRET` in the environment.
3. Restart the server.
4. Confirm: sign in as a test account on each plane (platform, tenant, supplier).

Do this if the secret is suspected to have leaked. Do not do it casually —
"we rotate secrets quarterly" is not a reason to log out every tenant on this
codebase's current design.

## `MASTER_KEY`

Encrypts secrets at rest: platform operator MFA secrets (`utils/secretBox.js`,
`v1:` prefix) and, per SAP connection, a random per-client data key that in
turn encrypts SAP credentials (`v2:` prefix, envelope encryption, ADR-0019).

**The envelope design exists exactly so this rotation is cheap.** Rotating
`MASTER_KEY` only needs the small per-connection data keys re-wrapped — not
every credential re-encrypted — because nothing but `wrapDataKey` /
`unwrapDataKey` (`utils/secretBox.js`) touches the master key directly.

There is no rotation script in this repo yet. Until one exists, rotating
`MASTER_KEY` safely means, in order:

1. Keep the old key available (as a second env var, e.g. `MASTER_KEY_OLD`) —
   do not just overwrite it, or every `v1:`/`v2:` blob becomes unreadable the
   instant the process restarts.
2. Write a one-off script (mirror `scripts/migrate-identity.js`'s shape) that,
   for every `PlatformUser` with an MFA secret and every `SapConnection`,
   decrypts with the old key and re-encrypts with the new one. For
   `SapConnection` this only needs to re-wrap `wrappedDataKey`, per the
   envelope design above — the credential ciphertext underneath is untouched.
3. Verify: decrypt one of each type with the new key before removing the old
   one from the environment.
4. Remove `MASTER_KEY_OLD` and redeploy.

Development and test never need this: they derive a stable key from
`JWT_SECRET` (ADR-0017) and are not where real secrets live.
