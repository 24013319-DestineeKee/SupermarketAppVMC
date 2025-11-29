// ...existing code...
const db = require('../db');

const ProductModel = {
  getAllProducts(callback) {
    const sql = 'SELECT id, productName, quantity, price, image, category FROM products';
    db.query(sql, (err, results) => callback(err, results));
  },

  getProductById(id, callback) {
    const sql = 'SELECT id, productName, quantity, price, image, category FROM products WHERE id = ?';
    db.query(sql, [id], (err, results) => {
      if (err) return callback(err);
      callback(null, results[0] || null);
    });
  },

  addProduct(product, callback) {
    const sql = 'INSERT INTO products (productName, quantity, price, image, category) VALUES (?, ?, ?, ?, ?)';
    const params = [
      product.productName,
      product.quantity,
      product.price,
      product.image,
      product.category || null
    ];
    db.query(sql, params, (err, result) => callback(err, result));
  },

  updateProduct(id, product, callback) {
    const sql = 'UPDATE products SET productName = ?, quantity = ?, price = ?, image = ?, category = ? WHERE id = ?';
    const params = [
      product.productName,
      product.quantity,
      product.price,
      product.image,
      product.category || null,
      id
    ];
    db.query(sql, params, (err, result) => callback(err, result));
  },

  decrementQuantity(id, amount, callback) {
    const sql = 'UPDATE products SET quantity = GREATEST(quantity - ?, 0) WHERE id = ?';
    db.query(sql, [amount, id], (err, result) => callback(err, result));
  },

  deleteProduct(id, callback) {
    const sql = 'DELETE FROM products WHERE id = ?';
    db.query(sql, [id], (err, result) => callback(err, result));
  }
};

module.exports = ProductModel;
// ...existing code...
