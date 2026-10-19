// Writing a CSV anything might open in Excel.
//
// Lifted out of services/export.service.js (which now imports it) when the
// supplier's report exports moved to the server (issue #280): a second
// hand-rolled `join(',')` is how one of two writers ends up without the
// formula guard below, and the rows it writes are the ones carrying
// supplier-chosen company names and SAP-sourced material descriptions.
//
// Formula injection (issue #75): a cell whose text begins with =, +, -, @,
// or a tab/carriage return is read as a formula by Excel/LibreOffice on
// open — `=HYPERLINK(...)`, `+cmd|'/c calc'!A1`, etc. A leading `'` is
// Excel's own "force text" marker: visible once opened, no longer
// executable. Neutralising here, at the one boundary every string cell is
// written through, beats trying to validate every source.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const neutraliseFormula = (str) => (FORMULA_PREFIX.test(str) ? `'${str}` : str);

const csvCell = (value) => {
  const str = neutraliseFormula(value == null ? '' : String(value));
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

/**
 * One CSV document from a column spec and the rows to write.
 *
 * @param {Array<{header: string, value: (row: any) => any}>} columns
 * @param {Array<object>} rows
 */
const toCsv = (columns, rows) => [
  columns.map((column) => csvCell(column.header)).join(','),
  ...rows.map((row) => columns.map((column) => csvCell(column.value(row))).join(',')),
].join('\r\n');

/**
 * Sends a CSV as a download. Express sets no charset on text/csv by default
 * and Excel then reads a UTF-8 file as the system codepage, which mangles a
 * supplier's name the moment it is not ASCII — hence the explicit charset.
 */
const sendCsv = (res, filename, csv) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
};

module.exports = { csvCell, toCsv, sendCsv, neutraliseFormula };
