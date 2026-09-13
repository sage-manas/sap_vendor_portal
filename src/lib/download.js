// Browser downloads the portal offers.
//
// A report endpoint sits behind `protect`, so it cannot be opened with
// window.open — the tab would carry no Authorization header and land on a 401.
// It is fetched with the session token and handed to the browser as a blob.

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';

const saveBlob = (blob, filename) => {
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
};

/** Fetches an authenticated API file and saves it. Throws on a non-2xx answer. */
export const downloadFromApi = async (path, filename) => {
  const headers = {};
  const token = localStorage.getItem('jwt_token');
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_URL}${path}`, { headers });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  saveBlob(await response.blob(), filename);
};

const csvCell = (value) => {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/**
 * Saves rows as CSV. `columns` is [{ header, value: (row) => … }], so the file
 * holds exactly what the table on screen shows.
 */
export const downloadCsv = (filename, columns, rows) => {
  const lines = [
    columns.map((column) => csvCell(column.header)).join(','),
    ...rows.map((row) => columns.map((column) => csvCell(column.value(row))).join(',')),
  ];
  saveBlob(new Blob([`${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' }), filename);
};
