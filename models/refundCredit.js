const db = require('../db');

const RefundCreditModel = {
  getLatestAvailableByUser(userId, callback) {
    const sql = `
      SELECT id, userId, refundRequestId, amount, status, usedOrderId, createdAt, usedAt
      FROM refund_credits
      WHERE userId = ? AND status = 'available'
      ORDER BY createdAt DESC
      LIMIT 1
    `;
    db.query(sql, [userId], (err, results) => callback(err, results && results[0]));
  },

  createCredit(payload, callback) {
    const sql = `
      INSERT INTO refund_credits (userId, refundRequestId, amount, status, usedOrderId)
      VALUES (?, ?, ?, 'available', NULL)
    `;
    const params = [
      payload.userId,
      payload.refundRequestId || null,
      payload.amount
    ];
    db.query(sql, params, (err, result) => callback(err, result));
  },

  markUsed(id, orderId, callback) {
    const sql = `
      UPDATE refund_credits
      SET status = 'used', usedOrderId = ?, usedAt = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'available'
    `;
    db.query(sql, [orderId || null, id], (err, result) => callback(err, result));
  }
};

module.exports = RefundCreditModel;
