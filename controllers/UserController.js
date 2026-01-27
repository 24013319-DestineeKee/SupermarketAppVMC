// ...existing code...
const UserModel = require('../models/user');
const MembershipModel = require('../models/membership');

// Basic validation helpers
const includeDetails = process.env.NODE_ENV !== 'production';

const sendDbError = (res, err, message = 'Database error') => {
  const payload = { error: message };
  if (includeDetails && err) payload.details = err.message;
  return res.status(500).json(payload);
};

const sendValidationError = (res, errors) => res.status(400).json({
  error: 'Validation failed',
  details: errors
});

const isValidId = (value) => {
  const id = parseInt(value, 10);
  return Number.isInteger(id) && id > 0;
};

const validateUserBody = (body, { requirePassword } = { requirePassword: false }) => {
  const errors = [];
  if (!body.username) errors.push('Username is required');
  if (!body.email) errors.push('Email is required');
  if (requirePassword && !body.password) errors.push('Password is required');
  if (body.password && body.password.length < 6) errors.push('Password must be at least 6 characters');
  return errors;
};

const UserController = {
  // List all users (JSON)
  listUsers(req, res) {
    UserModel.getAllUsers((err, users) => {
      if (err) return sendDbError(res, err);
      res.json(users);
    });
  },

  // Get single user by ID
  getUser(req, res) {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid user id' });
    const id = parseInt(req.params.id, 10);

    UserModel.getUserById(id, (err, user) => {
      if (err) return sendDbError(res, err);
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json(user);
    });
  },

  // Create new user
  createUser(req, res) {
    const { username, email, password, address, contact, role, joinMembership } = req.body;
    const errors = validateUserBody(req.body, { requirePassword: true });
    if (errors.length) return sendValidationError(res, errors);

    const user = { username, email, password, address: address || null, contact: contact || null, role: role || 'user' };

    UserModel.addUser(user, (err, result) => {
      if (err) return sendDbError(res, err);
      const userId = result.insertId;
      if (joinMembership === 'on' || joinMembership === true) {
        MembershipModel.createForUser(userId, () => {
          res.status(201).json({ id: userId, ...user, membership: true });
        });
      } else {
        res.status(201).json({ id: userId, ...user });
      }
    });
  },

  // Update existing user
  updateUser(req, res) {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid user id' });
    const id = parseInt(req.params.id, 10);

    const { username, email, password, address, contact, role } = req.body;
    const errors = validateUserBody(req.body, { requirePassword: false });
    if (errors.length) return sendValidationError(res, errors);

    const user = { username, email, password, address, contact, role };

    UserModel.updateUser(id, user, (err, result) => {
      if (err) return sendDbError(res, err);
      if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ message: 'User updated' });
    });
  },

  // Delete user
  deleteUser(req, res) {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid user id' });
    const id = parseInt(req.params.id, 10);

    UserModel.deleteUser(id, (err, result) => {
      if (err) return sendDbError(res, err);
      if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ message: 'User deleted' });
    });
  },

  toggleMembership(req, res) {
    if (!req.session || !req.session.user) {
      req.flash('error', 'Please log in.');
      return res.redirect('/login');
    }
    const userId = req.session.user.id;
    const action = req.body && req.body.action;
    if (action === 'join') {
      MembershipModel.createForUser(userId, (err) => {
        if (err) {
          console.error('Membership join error:', err);
          req.flash('error', 'Unable to join membership.');
        } else {
          if (req.session && req.session.user) {
            req.session.user.membership = true;
          }
          req.flash('success', 'Membership activated.');
        }
        return res.redirect('/profile');
      });
    } else if (action === 'cancel') {
      MembershipModel.removeByUser(userId, (err) => {
        if (req.session) {
          delete req.session.loyaltyRedemption;
          if (req.session.user) {
            req.session.user.membership = false;
          }
        }
        if (err) {
          console.error('Membership cancel error:', err);
          req.flash('error', 'Unable to cancel membership.');
        } else {
          req.flash('success', 'Membership cancelled.');
        }
        return res.redirect('/profile');
      });
    } else {
      req.flash('error', 'Invalid membership action.');
      return res.redirect('/profile');
    }
  }
};

module.exports = UserController;
// ...existing code...
