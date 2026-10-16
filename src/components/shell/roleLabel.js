// "client_admin" → "Client admin". Display only — the role registry
// (backend/config/roles.js) is never renamed.
export const roleLabel = (role) => (role ? role.charAt(0).toUpperCase() + role.slice(1).replace(/_/g, ' ') : '');
