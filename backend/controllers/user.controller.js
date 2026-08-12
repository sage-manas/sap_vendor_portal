const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { TENANT_ROLES } = require('../config/roles');
const { formatUserResponse } = require('./auth.controller');

// Tenant staff management. Every query here is tenant-scoped by the plugin, so
// a client_admin can only ever see and change their own workspace's users —
// there is no clientId parameter anywhere in this file by design.

// @desc    List this tenant's staff
// @route   GET /api/users
// @access  user:read
const listUsers = asyncHandler(async (req, res) => {
  const { role, status } = req.query;
  const query = {};
  if (role) query.role = role;
  if (status) query.status = status;

  const users = await User.find(query).sort({ createdAt: -1 });
  res.json({ success: true, users: users.map(formatUserResponse) });
});

// @desc    Get one staff account
// @route   GET /api/users/:id
// @access  user:read
const getUser = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    // 404 rather than 403 for another tenant's user: the API never confirms
    // that a document it cannot show exists.
    return next(ApiError.notFound('User not found'));
  }
  res.json({ success: true, user: formatUserResponse(user) });
});

// @desc    Change a staff account's role or profile
// @route   PATCH /api/users/:id
// @access  user:manage
const updateUser = asyncHandler(async (req, res, next) => {
  const { role, name, phone, jobTitle } = req.body;

  const user = await User.findById(req.params.id);
  if (!user) {
    return next(ApiError.notFound('User not found'));
  }

  if (role !== undefined) {
    if (!TENANT_ROLES.includes(role)) {
      return next(ApiError.badRequest(`role must be one of: ${TENANT_ROLES.join(', ')}`));
    }
    // A tenant that can demote its last administrator locks itself out.
    if (user.role === 'client_admin' && role !== 'client_admin' && !(await hasAnotherAdmin(user))) {
      return next(ApiError.badRequest('A workspace must keep at least one active client_admin'));
    }
    user.role = role;
  }

  if (name !== undefined) user.name = name;
  if (phone !== undefined) user.phone = phone;
  if (jobTitle !== undefined) user.jobTitle = jobTitle;

  await user.save();
  res.json({ success: true, user: formatUserResponse(user) });
});

const hasAnotherAdmin = async (user) =>
  (await User.countDocuments({ role: 'client_admin', status: 'Active', _id: { $ne: user._id } })) > 0;

// @desc    Suspend or reactivate a staff account
// @route   PUT /api/users/:id/status
// @access  user:manage
const setUserStatus = asyncHandler(async (req, res, next) => {
  const { status } = req.body;
  if (!['Active', 'Suspended'].includes(status)) {
    return next(ApiError.badRequest('status must be Active or Suspended'));
  }

  const user = await User.findById(req.params.id);
  if (!user) {
    return next(ApiError.notFound('User not found'));
  }
  if (String(user._id) === req.auth.id) {
    return next(ApiError.badRequest('You cannot change your own status'));
  }
  if (status === 'Suspended' && user.role === 'client_admin' && !(await hasAnotherAdmin(user))) {
    return next(ApiError.badRequest('A workspace must keep at least one active client_admin'));
  }

  user.status = status;
  user.suspendedAt = status === 'Suspended' ? new Date() : undefined;
  await user.save();

  res.json({ success: true, user: formatUserResponse(user) });
});

module.exports = { listUsers, getUser, updateUser, setUserStatus };
