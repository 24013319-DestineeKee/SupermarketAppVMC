const db = require('../db');

const ensureTable = (cb) => {
  const sql = `
    CREATE TABLE IF NOT EXISTS refund_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      orderId INT NOT NULL,
      userId INT NOT NULL,
      reason VARCHAR(255) NOT NULL,
      description TEXT,
      image VARCHAR(255),
      supportType VARCHAR(32) DEFAULT 'full_refund',
      status VARCHAR(32) DEFAULT 'pending',
      refundAmount DECIMAL(10,2) DEFAULT 0.00,
      resolutionNote TEXT,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_order (orderId),
      INDEX idx_user (userId)
    )
  `;
  db.query(sql, cb);
};

const ensureColumns = (cb) => {
  const columnCheck = `
    SELECT COLUMN_NAME FROM information_schema.columns
    WHERE TABLE_NAME = 'refund_requests' AND COLUMN_NAME = 'supportType'
  `;
  db.query(columnCheck, (err, rows) => {
    if (err) return cb(err);
    if (rows && rows.length) return cb();
    const alterSql = "ALTER TABLE refund_requests ADD COLUMN supportType VARCHAR(32) DEFAULT 'full_refund'";
    db.query(alterSql, cb);
  });
};

const safeRun = (fn, callback) => {
  ensureTable((tableErr) => {
    if (tableErr) return callback(tableErr);
    ensureColumns((colErr) => {
      if (colErr) return callback(colErr);
      fn(callback);
    });
  });
};

const RefundModel = {
  createReport(payload, callback) {
    return safeRun((cb) => {
      const sql = `
        INSERT INTO refund_requests (orderId, userId, reason, description, image, supportType, status, refundAmount)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 0.00)
      `;
      const params = [
        payload.orderId,
        payload.userId,
        payload.reason,
        payload.description || '',
        payload.image || null,
        payload.supportType || 'full_refund'
      ];
      db.query(sql, params, (err, result) => cb(err, result && result.insertId));
    }, callback);
  },

  getReportByOrder(orderId, callback) {
    return safeRun((cb) => {
      const sql = 'SELECT * FROM refund_requests WHERE orderId = ? ORDER BY createdAt DESC LIMIT 1';
      db.query(sql, [orderId], (err, results) => cb(err, results && results[0]));
    }, callback);
  },

  getReportsByOrderIds(orderIds, callback) {
    if (!orderIds || !orderIds.length) return callback(null, {});
    return safeRun((cb) => {
      const sql = 'SELECT * FROM refund_requests WHERE orderId IN (?) ORDER BY createdAt DESC';
      db.query(sql, [orderIds], (err, results) => {
        if (err) return cb(err);
        const map = {};
        results.forEach((row) => {
          if (!map[row.orderId]) map[row.orderId] = row;
        });
        cb(null, map);
      });
    }, callback);
  },

  getAllReports(callback) {
    return safeRun((cb) => {
      const sql = `
        SELECT r.*, o.userId, o.totalAmount AS orderTotal, o.status AS orderStatus,
               u.username, u.email
        FROM refund_requests r
        LEFT JOIN orders o ON o.id = r.orderId
        LEFT JOIN users u ON u.id = o.userId
        ORDER BY r.createdAt DESC
      `;
      db.query(sql, (err, results) => cb(err, results));
    }, callback);
  },

  getReportById(id, callback) {
    return safeRun((cb) => {
      const sql = `
        SELECT r.*, o.userId, o.totalAmount AS orderTotal, o.status AS orderStatus,
               u.username, u.email
        FROM refund_requests r
        LEFT JOIN orders o ON o.id = r.orderId
        LEFT JOIN users u ON u.id = o.userId
        WHERE r.id = ?
        LIMIT 1
      `;
      db.query(sql, [id], (err, results) => cb(err, results && results[0]));
    }, callback);
  },

  updateReport(id, updates, callback) {
    return safeRun((cb) => {
      const fields = [];
      const params = [];

      if (updates.status) {
        fields.push('status = ?');
        params.push(updates.status);
      }
      if (updates.supportType) {
        fields.push('supportType = ?');
        params.push(updates.supportType);
      }
      if (updates.refundAmount != null) {
        fields.push('refundAmount = ?');
        params.push(updates.refundAmount);
      }
      if (updates.resolutionNote != null) {
        fields.push('resolutionNote = ?');
        params.push(updates.resolutionNote);
      }

      if (!fields.length) return cb(null, null);

      const sql = `UPDATE refund_requests SET ${fields.join(', ')} WHERE id = ?`;
      params.push(id);
      db.query(sql, params, (err, result) => cb(err, result));
    }, callback);
  }
};

module.exports = RefundModel;
