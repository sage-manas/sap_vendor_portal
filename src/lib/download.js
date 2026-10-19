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

// `downloadCsv` lived here: it wrote a CSV from "exactly what the table on
// screen shows", which was the bug (issue #280). What the table showed was
// one page of a list endpoint, and the file it produced carried the name and
// the headers of a complete export. The exports are server endpoints now
// (backend/controllers/reportExport.controller.js), fetched through
// downloadFromApi above.
//
// Deleted rather than left unused, for the reason recorded in
// usePOs.js's header: a working client-side CSV writer sitting beside the
// endpoints that replaced it is one import away from putting a partial
// export back in front of a supplier. Writing a CSV in the browser from
// whatever rows are loaded is not a thing this app should make easy.
