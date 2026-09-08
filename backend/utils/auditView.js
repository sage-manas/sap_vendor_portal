const { ALL_AUDIT_ACTIONS } = require('../config/auditActions');

// How an audit entry is presented, in one place, because two planes read the
// same trail with different rights.
//
// The platform console sees the entry whole. A tenant sees its own rows, but a
// platform-plane actor is reduced to "VendorConnect operations": that an
// operator suspended their workspace is the tenant's business; which operator,
// and at what address, is not (ADR-0025).

const PLATFORM_ACTOR_LABEL = 'VendorConnect operations';

const formatAuditEntry = (entry, { revealPlatformActor = true } = {}) => {
  const platformActor = entry.plane === 'platform';
  const hide = platformActor && !revealPlatformActor;

  return {
    id: entry.pk,
    source: 'audit',
    at: entry.at,
    clientId: entry.clientId,
    action: entry.action,
    actor: hide
      ? { id: null, email: null, role: PLATFORM_ACTOR_LABEL, plane: 'platform' }
      : { id: entry.actorId, email: entry.actorEmail, role: entry.actorRole, plane: entry.plane },
    target: entry.target || null,
    meta: entry.meta || {},
    ...(hide ? {} : { ip: entry.ip }),
  };
};

// "Everything that happened to suppliers" — the subject is the action prefix,
// matched against the registry rather than by a regex over user input.
const actionsForSubject = (subject) =>
  ALL_AUDIT_ACTIONS.filter((action) => action.startsWith(`${subject}.`));

// The shared `?from=&to=&page=&limit=` handling. Returns a filter fragment and
// the pagination the caller should apply.
const auditQuery = ({ from, to, page = 1, limit = 50 }, maxLimit = 200) => {
  const perPage = Math.min(Number(limit) || 50, maxLimit);
  const currentPage = Math.max(Number(page) || 1, 1);

  const range = (from || to)
    ? { at: { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) } }
    : {};

  return { range, perPage, currentPage, skip: (currentPage - 1) * perPage };
};

module.exports = { formatAuditEntry, actionsForSubject, auditQuery, PLATFORM_ACTOR_LABEL };
