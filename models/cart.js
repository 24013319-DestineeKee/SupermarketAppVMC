const db = require('../db');

const CartModel = {
  getCartByUser(userId, callback) {
    const sql = `
      SELECT ci.id AS cartItemId,
             ci.product_id AS productId,
             ci.quantity,
             0 AS discount,
             p.productName,
             p.price,
             p.image
      FROM cart_items ci
      JOIN products p ON p.id = ci.product_id
      WHERE ci.user_id = ?
      ORDER BY ci.id DESC
    `;
    db.query(sql, [userId], (err, results) => callback(err, results));
  },

  addOrUpdateItem(userId, productId, quantity, callback) {
    const selectSql = 'SELECT id, quantity FROM cart_items WHERE user_id = ? AND product_id = ?';
    db.query(selectSql, [userId, productId], (err, results) => {
      if (err) return callback(err);
      if (results.length > 0) {
        const current = results[0];
        const newQty = current.quantity + quantity;
        const updateSql = 'UPDATE cart_items SET quantity = ? WHERE id = ? AND user_id = ?';
        return db.query(updateSql, [newQty, current.id, userId], (updateErr) => callback(updateErr));
      }
      const insertSql = 'INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?, ?, ?)';
      return db.query(insertSql, [userId, productId, quantity], (insertErr) => callback(insertErr));
    });
  },

  updateQuantity(userId, cartItemId, quantity, callback) {
    const sql = 'UPDATE cart_items SET quantity = ? WHERE id = ? AND user_id = ?';
    db.query(sql, [quantity, cartItemId, userId], (err, result) => {
      if (err) return callback(err);
      if (result.affectedRows === 0) return callback(new Error('Cart item not found'));
      return callback(null);
    });
  },

  removeItem(userId, cartItemId, callback) {
    const sql = 'DELETE FROM cart_items WHERE id = ? AND user_id = ?';
    db.query(sql, [cartItemId, userId], (err, result) => {
      if (err) return callback(err);
      if (result.affectedRows === 0) return callback(new Error('Cart item not found'));
      return callback(null);
    });
  }
};

module.exports = CartModel;
