import { openToShip } from './rules';

// The PO lines a supplier can put on a shipment notice: on an order they have
// acknowledged (or already shipped part of), still open, and not a service
// line (a service is confirmed by entry sheet in SAP, never shipped). An
// order SAP holds that the portal has not recorded yet has no row to ship
// against, so it is left out. The API checks all of this again.

const SHIPPABLE = ['Acknowledged', 'Dispatched'];

const isServiceLine = (item) => item.accountAssignmentCategory === 'D'
  || (Array.isArray(item.serviceEntries) && item.serviceEntries.length > 0);

export const lineKey = (poId, line) => `${poId}:${line}`;

/** Plant as a filter value: '' when the line states none. */
export const plantOf = (item) => item.plant || '';

/**
 * @param {object[]} pos - from GET /pos (items carry openToShipQuantity)
 * @returns {Array<{key, po, item, open}>}
 */
export const shippableLines = (pos) => pos
  .filter((po) => po && !po.sapOnly && !po.sapDeletedAt && SHIPPABLE.includes(po.status))
  .flatMap((po) => (po.items || [])
    .filter((item) => item && !isServiceLine(item) && openToShip(item) > 0)
    .map((item) => ({ key: lineKey(po.id, item.line), po, item, open: openToShip(item) })));
