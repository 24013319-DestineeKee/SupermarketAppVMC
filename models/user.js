const db = require('../db');

const UserModel = {
  getAllUsers(callback) {
    const sql = 'SELECT id, username, email, password, address, contact, role FROM users';
    db.query(sql, (err, results) => callback(err, results));
  },

  getUserById(id, callback) {
    const sql = 'SELECT id, username, email, password, address, contact, role FROM users WHERE id = ?';
    db.query(sql, [id], (err, results) => {
      if (err) return callback(err);
      callback(null, results[0] || null);
    });
  },

  addUser(user, callback) {
    const sql = 'INSERT INTO users (username, email, password, address, contact, role) VALUES (?, ?, ?, ?, ?, ?)';
    const params = [
      user.username,
      user.email,
      user.password,
      user.address || null,
      user.contact || null,
      user.role || 'user'
    ];
    db.query(sql, params, (err, result) => callback(err, result));
  },

  updateUser(id, user, callback) {
    const sql = 'UPDATE users SET username = ?, email = ?, password = ?, address = ?, contact = ?, role = ? WHERE id = ?';
    const params = [
      user.username,
      user.email,
      user.password,
      user.address || null,
      user.contact || null,
      user.role || 'user',
      id
    ];
    db.query(sql, params, (err, result) => callback(err, result));
  },

  deleteUser(id, callback) {
    const sql = 'DELETE FROM users WHERE id = ?';
    db.query(sql, [id], (err, result) => callback(err, result));
  }
};

module.exports = UserModel;