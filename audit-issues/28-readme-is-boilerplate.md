<!-- title: DOCS: the repository README is still the unmodified create-next-app boilerplate -->
<!-- labels: documentation,severity:low,chore -->

**Severity:** Low, but it is the first thing anyone sees.

## Summary

`README.md` is the stock output of `create-next-app`: "This is a Next.js project bootstrapped
with create-next-app", the four package-manager variants, and links to the Next.js tutorial
and Vercel deployment docs. It says nothing about VendorConnect.

Meanwhile the genuinely useful orientation material — `PROJECT_CONTEXT.md`, `AGENTS.md`,
`SERVER_SETUP_QUICK_READ.md`, `HOSTING_PROVIDER_HANDOFF.md`, `docs/runbooks/` — is
discoverable only by knowing it exists.

## Evidence

`README.md:1`:
```
This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`]...
```

## Expected

A README that states what the product is, what the two planes are, how to get a development
environment up (Postgres via `docker-compose`, `prisma migrate`, the two processes — API and
jobs worker), how to run the tests, and where the deeper documents live.

## Suggested fix

Rewrite to roughly: one-paragraph product description; architecture in five lines
(Next.js frontend, Express API, Postgres via Prisma, separate jobs worker, SAP adapter with
pluggable drivers); prerequisites; setup commands; test commands; a table pointing at
`PROJECT_CONTEXT.md`, `AGENTS.md`, `DECISIONS.md`, `docs/` and `docs/runbooks/`.

Do not restate what those documents cover — link to them.

## Acceptance criteria

- [ ] A developer can clone, set up and run the tests from the README alone.
- [ ] No create-next-app boilerplate remains.
- [ ] The jobs worker is documented as a separate process.
