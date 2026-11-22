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
 * @param {object} [options]
 * @param {Object<string, number>} [options.own] - by line key, quantity a
 *   shipment being changed already holds. The API counts it as in transit;
 *   to that shipment it is still available, so it is added back.
 * @returns {Array<{key, po, item, open}>}
 */
export const shippableLines = (pos, { own = {} } = {}) => pos
  .filter((po) => po && !po.sapOnly && !po.sapDeletedAt && SHIPPABLE.includes(po.status))
  .flatMap((po) => (po.items || [])
    .filter((item) => item && !isServiceLine(item))
    .map((item) => {
      const key = lineKey(po.id, item.line);
      // Thousandths, as the API counts, so 33.3 + 66.7 is the 100 it is.
      const open = Math.round((openToShip(item) + (Number(own[key]) || 0)) * 1000) / 1000;
      return { key, po, item: { ...item, openToShipQuantity: open }, open };
    })
    .filter(({ open }) => open > 0));
