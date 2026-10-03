import { apiClient } from './api-client';

// Opening an uploaded document.
//
// A document sits behind the session, so a plain <a href="/api/uploads/<id>">
// cannot open it: the browser follows the link without the Authorization header
// and lands on a 401. The API hands out a short-lived signed link instead
// (GET /uploads/:id/link) — object storage serves the bytes itself, the link is
// the credential, and it stops working after a couple of minutes — and the
// document opens by navigating to that.

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';

/**
 * The document id behind whatever the uploads API returned: a full
 * `{ documentId, url }`, or an older record that carries only the URL. An older
 * record that kept just a file name has no id (null).
 */
export const documentIdOf = (file) => {
  if (!file || typeof file !== 'object') return null;
  if (file.documentId) return String(file.documentId);
  const match = typeof file.url === 'string' ? /\/uploads\/([^/?#]+)/.exec(file.url) : null;
  return match ? match[1] : null;
};

/** Opens the document in a new tab. Throws, with a message fit to show, if it cannot. */
export const openDocument = async (file) => {
  const id = documentIdOf(file);
  if (!id) throw new Error('This document is not available to open.');

  const link = await apiClient.get(`/uploads/${encodeURIComponent(id)}/link`);
  if (!link?.url) throw new Error('Could not get a link for this document. Try again.');

  // The local development driver answers with a path on the API itself.
  const target = new URL(link.url, API_URL).toString();
  window.open(target, '_blank', 'noopener,noreferrer');
};
