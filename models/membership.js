const db = require('../db');

const ensureTable = (cb) => {
  const sql = `
    CREATE TABLE IF NOT EXISTS memberships (
      id INT AUTO_INCREMENT PRIMARY KEY,
      userId INT NOT NULL UNIQUE,
      points INT DEFAULT 0,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_user (userId)
    )
  `;
  db.query(sql, cb);
};

const safeRun = (fn, callback) => {
  ensureTable((tableErr) => {
    if (tableErr) return callback(tableErr);
    fn(callback);
  });
};

const MembershipModel = {
  createForUser(userId, callback) {
    if (!userId) return callback(new Error('Missing userId'));
    return safeRun((cb) => {
      const sql = 'INSERT IGNORE INTO memberships (userId, points) VALUES (?, 0)';
      db.query(sql, [userId], cb);
    }, callback);
  },

  getByUser(userId, callback) {
    if (!userId) return callback(null, null);
    return safeRun((cb) => {
      const sql = 'SELECT * FROM memberships WHERE userId = ? LIMIT 1';
      db.query(sql, [userId], (err, rows) => cb(err, rows && rows[0]));
    }, callback);
  },

  addPoints(userId, delta, callback) {
    if (!userId || !Number.isFinite(delta)) return callback(new Error('Invalid params'));
    return safeRun((cb) => {
      const sql = 'INSERT INTO memberships (userId, points) VALUES (?, ?) ON DUPLICATE KEY UPDATE points = points + VALUES(points)';
      db.query(sql, [userId, Math.floor(delta)], cb);
    }, callback);
  },

  removeByUser(userId, callback) {
    if (!userId) return callback(new Error('Missing userId'));
    return safeRun((cb) => {
      const sql = 'DELETE FROM memberships WHERE userId = ?';
      db.query(sql, [userId], cb);
    }, callback);
  }
};

module.exports = MembershipModel;
