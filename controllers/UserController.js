// ...existing code...
const UserModel = require('../models/user');

const UserController = {
  // List all users (JSON)
  listUsers(req, res) {
    UserModel.getAllUsers((err, users) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      res.json(users);
    });
  },

  // Get single user by ID
  getUser(req, res) {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid user id' });

    UserModel.getUserById(id, (err, user) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json(user);
    });
  },

  // Create new user
  createUser(req, res) {
    const { username, email, password, address, contact, role } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields: username, email, password' });
    }

    const user = { username, email, password, address: address || null, contact: contact || null, role: role || 'user' };

    UserModel.addUser(user, (err, result) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      res.status(201).json({ id: result.insertId, ...user });
    });
  },

  // Update existing user
  updateUser(req, res) {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid user id' });

    const { username, email, password, address, contact, role } = req.body;
    const user = { username, email, password, address, contact, role };

    UserModel.updateUser(id, user, (err, result) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ message: 'User updated' });
    });
  },

  // Delete user
  deleteUser(req, res) {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid user id' });

    UserModel.deleteUser(id, (err, result) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ message: 'User deleted' });
    });
  }
};

module.exports = UserController;
// ...existing code...