import { isPlatformPath, isAuthPath } from './planes';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';

export const apiClient = {
  async request(endpoint, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    
    // Add Authorization header with JWT token if available
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('jwt_token');
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    const config = {
      ...options,
      headers,
    };

    // GET is the only method this app has ever treated as safe to silently
    // no-op on a network failure. A POST/PUT/PATCH/DELETE whose response
    // never arrived is NOT known to have failed — the request may already
    // have reached the server (issue #119) — so it must never collapse into
    // the same `null` a harmless failed read produces.
    const isRead = (options.method || 'GET').toUpperCase() === 'GET';

    let response;
    try {
      response = await fetch(`${BASE_URL}${endpoint}`, config);
    } catch (err) {
      // A genuine fetch rejection: DNS failure, connection refused, offline.
      // The request never reached the server at all.
      if (isRead) {
        console.warn(`[apiClient] Network connectivity error on ${endpoint}`);
        return null;
      }
      console.warn(`[apiClient] Network connectivity error on ${endpoint} — outcome unknown`);
      err.offline = true;
      throw err;
    }

    if (!response.ok) {
      if (response.status === 401 && typeof window !== 'undefined') {
        localStorage.removeItem('jwt_token');
        localStorage.removeItem('clerk_user_id');
        localStorage.removeItem('sap_vendor_profile_data');
        // Never redirect out of the platform console: it authenticates
        // through platform-client.js and does not hold a supplier token.
        if (!isAuthPath(window.location.pathname) && !isPlatformPath(window.location.pathname)) {
          window.location.href = '/sign-in';
        }
      }
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.error || `Request failed with status ${response.status}`);
      // The API answers a validation failure with a { field: message } map;
      // carrying it on the error is what lets a form point at the field
      // rather than only showing the summary line.
      error.status = response.status;
      error.errors = errorData.errors;
      error.reason = errorData.reason;
      throw error;
    }

    if (response.status === 204) return null;
    return response.json();
  },

  get(endpoint, headers = {}) {
    return this.request(endpoint, { method: 'GET', headers });
  },

  post(endpoint, body, headers = {}) {
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
      headers,
    });
  },

  put(endpoint, body, headers = {}) {
    return this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers,
    });
  },

  patch(endpoint, body, headers = {}) {
    return this.request(endpoint, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers,
    });
  },

  delete(endpoint, headers = {}) {
    return this.request(endpoint, { method: 'DELETE', headers });
  },

  /**
   * For an endpoint that answers with a file (Content-Disposition: attachment)
   * rather than JSON — request()'s unconditional response.json() can't read
   * that. Returns the blob plus the filename the server chose, so the caller
   * only has to trigger the save.
   */
  async getBlob(endpoint) {
    const headers = {};
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('jwt_token');
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${BASE_URL}${endpoint}`, { method: 'GET', headers });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Request failed with status ${response.status}`);
    }

    const disposition = response.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    // A missing header used to fail silently into an unnamed 'export' file —
    // exactly what CORS not exposing Content-Disposition did to every download
    // in the app (issue #110). Loud here so that regressing the CORS config
    // shows up the moment someone downloads something, not months later.
    if (!match) {
      console.warn(`[apiClient.getBlob] No Content-Disposition filename for ${endpoint} — saving as 'export'.`);
    }
    return { blob: await response.blob(), filename: match ? match[1] : 'export' };
  }
};
