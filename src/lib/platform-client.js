// The platform console's API client.
//
// Deliberately separate from `api-client.js`, and storing its token under its
// own key: an operator session and a supplier session must never be mistaken
// for one another, and signing out of one must not sign you into the other.
//
// It also surfaces the MFA refusals as structured errors, because "enrol an
// authenticator" and "type your code" are different screens.

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
const TOKEN_KEY = 'vc_platform_token';

export const platformToken = {
  get: () => (typeof window === 'undefined' ? null : localStorage.getItem(TOKEN_KEY)),
  set: (token) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class PlatformApiError extends Error {
  constructor(message, { status, reason, errors } = {}) {
    super(message);
    this.status = status;
    this.reason = reason;   // 'mfa_enrolment_required' | 'mfa_verification_required' | …
    this.errors = errors;   // field → message, from the zod validator
  }
}

const request = async (endpoint, { method = 'GET', body, auth = true } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  const token = auth ? platformToken.get() : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${BASE_URL}/platform${endpoint}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    // A dead session clears itself here; the layout notices and shows the
    // sign-in screen rather than each page inventing its own redirect.
    if (response.status === 401 && auth) platformToken.clear();

    throw new PlatformApiError(
      payload.error || Object.values(payload.errors || {})[0] || `Request failed (${response.status})`,
      { status: response.status, reason: payload.reason, errors: payload.errors }
    );
  }

  return payload;
};

export const platformApi = {
  // Auth — the only calls that work before MFA has been cleared.
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password }, auth: false }),
  forgotPassword: (email) => request('/auth/forgot-password', { method: 'POST', body: { email }, auth: false }),
  resetPassword: (token, password) => request('/auth/reset-password', { method: 'POST', body: { token, password }, auth: false }),
  me: () => request('/auth/me'),
  changePassword: (currentPassword, newPassword) => request('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),
  enrolMfa: () => request('/auth/mfa/enrol', { method: 'POST', body: {} }),
  verifyMfa: (code) => request('/auth/mfa/verify', { method: 'POST', body: { code } }),

  // Tenants
  listTenants: (query = '') => request(`/tenants${query}`),
  getTenant: (clientId) => request(`/tenants/${clientId}`),
  createTenant: (body) => request('/tenants', { method: 'POST', body }),
  updateTenant: (clientId, body) => request(`/tenants/${clientId}`, { method: 'PUT', body }),
  tenantLifecycle: (clientId, action, reason) => request(`/tenants/${clientId}/${action}`, { method: 'POST', body: { ...(reason && { reason }) } }),
  exportTenant: (clientId) => request(`/tenants/${clientId}/export`),
  reissueCredentials: (clientId, userId) => request(`/tenants/${clientId}/administrators/${userId}/credentials`, { method: 'POST', body: {} }),

  // Operators
  listOperators: () => request('/operators'),
  createOperator: (body) => request('/operators', { method: 'POST', body }),
  updateOperator: (id, body) => request(`/operators/${id}`, { method: 'PUT', body }),
  operatorLifecycle: (id, action, reason) => request(`/operators/${id}/${action}`, { method: 'POST', body: { ...(reason && { reason }) } }),
  resetOperatorMfa: (id, reason) => request(`/operators/${id}/mfa/reset`, { method: 'POST', body: { ...(reason && { reason }) } }),

  // SAP configuration. `secrets` goes up and never comes back down: the read
  // endpoint returns the *names* of the credentials that are set, never values.
  getSap: (clientId) => request(`/tenants/${clientId}/sap`),
  configureSap: (clientId, environment, body) => request(`/tenants/${clientId}/sap/${environment}`, { method: 'PUT', body }),
  testSap: (clientId, environment) => request(`/tenants/${clientId}/sap/${environment}/test`, { method: 'POST', body: {} }),
  promoteSap: (clientId, environment, reason) => request(`/tenants/${clientId}/sap/promote`, { method: 'POST', body: { environment, ...(reason && { reason }) } }),
  sapAudit: (clientId, query = '') => request(`/tenants/${clientId}/sap/audit${query}`),

  // Audit and health
  audit: (query = '') => request(`/audit${query}`),
  auditFilters: () => request('/audit/filters'),
  health: () => request('/health'),
};
