// ...existing code...
const ProductModel = require('../models/product');

const ProductController = {
  // List all products (JSON)
  listProducts(req, res) {
    ProductModel.getAllProducts((err, products) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      res.json(products);
    });
  },

  // Get single product by ID (JSON)
  getProduct(req, res) {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid product id' });

    ProductModel.getProductById(id, (err, product) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      if (!product) return res.status(404).json({ error: 'Product not found' });
      res.json(product);
    });
  },

  // Create a new product (accepts form-data with optional file upload in req.file)
  createProduct(req, res) {
    const { productName, quantity, price } = req.body;
    if (!productName || quantity == null || price == null) {
      return res.status(400).json({ error: 'Missing required fields: productName, quantity, price' });
    }

    const product = {
      productName,
      quantity: Number(quantity),
      price: Number(price),
      image: req.file ? req.file.filename : (req.body.image || null)
    };

    ProductModel.addProduct(product, (err, result) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      res.status(201).json({ id: result.insertId, ...product });
    });
  },

  // Update existing product (partial updates allowed; accepts file upload in req.file)
  updateProduct(req, res) {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid product id' });

    ProductModel.getProductById(id, (err, existing) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      if (!existing) return res.status(404).json({ error: 'Product not found' });

      const { productName, quantity, price, currentImage } = req.body;
      const product = {
        productName: productName != null ? productName : existing.productName,
        quantity: quantity != null ? Number(quantity) : existing.quantity,
        price: price != null ? Number(price) : existing.price,
        image: req.file ? req.file.filename : (currentImage != null ? currentImage : existing.image)
      };

      ProductModel.updateProduct(id, product, (err, result) => {
        if (err) return res.status(500).json({ error: 'Database error', details: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Product not found' });
        res.json({ message: 'Product updated' });
      });
    });
  },

  // Delete a product
  deleteProduct(req, res) {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid product id' });

    ProductModel.deleteProduct(id, (err, result) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      if (result.affectedRows === 0) return res.status(404).json({ error: 'Product not found' });
      res.json({ message: 'Product deleted' });
    });
  }
};

module.exports = ProductController;
// ...existing code...