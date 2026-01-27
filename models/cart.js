const db = require('../db');

const CartModel = {
  getCartItemByProduct(userId, productId, callback) {
    const sql = 'SELECT id, product_id AS productId, quantity FROM cart_items WHERE user_id = ? AND product_id = ? LIMIT 1';
    db.query(sql, [userId, productId], (err, results) => {
      if (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') return callback(null, { missingTable: true });
        return callback(err);
      }
      callback(null, results[0] || null);
    });
  },

  getCartItemWithProduct(userId, cartItemId, callback) {
    const sql = `
      SELECT ci.id, ci.product_id AS productId, ci.quantity AS cartQuantity, p.quantity AS productStock
      FROM cart_items ci
      JOIN products p ON p.id = ci.product_id
      WHERE ci.id = ? AND ci.user_id = ?
      LIMIT 1
    `;
    db.query(sql, [cartItemId, userId], (err, results) => {
      if (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') return callback(null, { missingTable: true });
        return callback(err);
      }
      callback(null, results[0] || null);
    });
  },

  getCartByUser(userId, callback) {
    // Use a compact SQL string to avoid accidental duplication/formatting issues
    const sql = 'SELECT ci.id AS cartItemId, ci.product_id AS productId, ci.quantity, 0 AS discount, p.productName, p.price, p.image FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.user_id = ? ORDER BY ci.id DESC';
    db.query(sql, [userId], (err, results) => {
      if (err) {
        // If the cart_items table is missing, degrade gracefully so /cart and /checkout still load.
        if (err.code === 'ER_NO_SUCH_TABLE') {
          return callback(null, []);
        }
        return callback(err);
      }
      callback(null, results);
    });
  },

  addOrUpdateItem(userId, productId, quantity, callback) {
    const selectSql = 'SELECT id, quantity FROM cart_items WHERE user_id = ? AND product_id = ?';
    db.query(selectSql, [userId, productId], (err, results) => {
      if (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') return callback(null, { missingTable: true });
        return callback(err);
      }
      if (results.length > 0) {
        const current = results[0];
        const newQty = current.quantity + quantity;
        const updateSql = 'UPDATE cart_items SET quantity = ? WHERE id = ? AND user_id = ?';
        return db.query(updateSql, [newQty, current.id, userId], (updateErr) => {
          if (updateErr && updateErr.code === 'ER_NO_SUCH_TABLE') return callback(null, { missingTable: true });
          callback(updateErr, { updated: true });
        });
      }
      const insertSql = 'INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?, ?, ?)';
      return db.query(insertSql, [userId, productId, quantity], (insertErr) => {
        if (insertErr && insertErr.code === 'ER_NO_SUCH_TABLE') return callback(null, { missingTable: true });
        callback(insertErr, { inserted: true });
      });
    });
  },

  updateQuantity(userId, cartItemId, quantity, callback) {
    const sql = 'UPDATE cart_items SET quantity = ? WHERE id = ? AND user_id = ?';
    db.query(sql, [quantity, cartItemId, userId], (err, result) => {
      if (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') return callback(null, { missingTable: true });
        return callback(err);
      }
      if (result.affectedRows === 0) return callback(new Error('Cart item not found'));
      return callback(null, { updated: true });
    });
  },

  removeItem(userId, cartItemId, callback) {
    const sql = 'DELETE FROM cart_items WHERE id = ? AND user_id = ?';
    db.query(sql, [cartItemId, userId], (err, result) => {
      if (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') return callback(null, { missingTable: true });
        return callback(err);
      }
      if (result.affectedRows === 0) return callback(new Error('Cart item not found'));
      return callback(null, { deleted: true });
    });
  },

  clearCartByUser(userId, callback) {
    const sql = 'DELETE FROM cart_items WHERE user_id = ?';
    db.query(sql, [userId], (err) => {
      if (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') return callback(null, { missingTable: true });
        return callback(err);
      }
      return callback(null, { cleared: true });
    });
  }
};

module.exports = CartModel;
