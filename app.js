const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');

const ProductModel = require('./models/product');
const UserModel = require('./models/user');
const OrderModel = require('./models/order');
const ProductController = require('./controllers/ProductController');
const UserController = require('./controllers/UserController');
const CartController = require('./controllers/CartController');

const app = express();

// --- Multer for uploads (product images / optional user pictures) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/images'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_');
    cb(null, `${base}-${Date.now()}${ext.toLowerCase()}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image uploads are allowed'));
    }
    cb(null, true);
  }
});

// NOTE: direct mysql connection removed — models/controllers use require('../db')

// --- view engine / static / parsing ---
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// --- session + flash ---
app.use(session({
  secret: process.env.SESSION_SECRET || 'keyboard cat',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(flash());

// expose flash messages to all views as `messages`
app.use((req, res, next) => {
  res.locals.messages = {
    success: req.flash('success') || [],
    error: req.flash('error') || []
  };
  next();
});

// --- auth helpers ---
const checkAuthenticated = (req, res, next) => {
  if (req.session && req.session.user) return next();
  req.flash('error', 'Please log in to view this resource');
  res.redirect('/login');
};
const checkAdmin = (req, res, next) => {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  req.flash('error', 'Access denied');
  res.redirect('/shopping');
};

// --- validation middleware for register ---
const validateRegistration = (req, res, next) => {
  const { username, email, password, address, contact } = req.body;
  if (!username || !email || !password || !address || !contact) {
    req.flash('error', 'All fields are required.');
    req.flash('formData', req.body);
    return res.redirect('/register');
  }
  if (password.length < 6) {
    req.flash('error', 'Password should be at least 6 characters');
    req.flash('formData', req.body);
    return res.redirect('/register');
  }
  next();
};

// ----------------- View routes (render pages / redirect flows) -----------------

app.get('/', (req, res) => res.render('index', { user: req.session.user }));

// Inventory (admin) - use model to render view list
app.get('/inventory', checkAuthenticated, checkAdmin, (req, res) => {
  ProductModel.getAllProducts((err, products) => {
    if (err) {
      console.error('DB error:', err);
      return res.status(500).send('Database error');
    }
    res.render('inventory', { products, user: req.session.user });
  });
});

// Register / Login (view flows) - keep form handling here to allow hashing + redirect UX
app.get('/register', (req, res) => {
  res.render('register', { messages: req.flash('error'), formData: req.flash('formData')[0] });
});

app.post('/register', validateRegistration, (req, res) => {
  const { username, email, password, address, contact } = req.body;
  const hashed = crypto.createHash('sha1').update(password).digest('hex');
  const user = { username, email, password: hashed, address, contact, role: 'user' };

  // Use model to add user and then redirect (controller API exists for JSON; keep view UX here)
  UserModel.addUser(user, (err) => {
    if (err) {
      console.error('Error adding user:', err);
      req.flash('error', 'Registration failed');
      return res.redirect('/register');
    }
    req.flash('success', 'Registration successful! Please log in.');
    res.redirect('/login');
  });
});

app.get('/login', (req, res) => {
  res.render('login', { messages: req.flash('success'), errors: req.flash('error') });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    req.flash('error', 'All fields are required.');
    return res.redirect('/login');
  }
  const hashed = crypto.createHash('sha1').update(password).digest('hex');

  // Use model to find the user
  UserModel.getAllUsers((err, users) => {
    if (err) {
      console.error('DB error:', err);
      req.flash('error', 'Login failed');
      return res.redirect('/login');
    }
    const found = users.find(u => u.email === email && u.password === hashed);
    if (!found) {
      req.flash('error', 'Invalid email or password.');
      return res.redirect('/login');
    }
    // Use email as the display identifier after login so views that reference `user.username`
    // will show the customer's email instead of their name.
    req.session.user = { ...found, username: found.email };
    req.flash('success', 'Login successful!');
    return found.role === 'user' ? res.redirect('/shopping') : res.redirect('/inventory');
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Shopping / cart / product pages (use models for rendering)
app.get('/shopping', checkAuthenticated, (req, res) => {
  ProductModel.getAllProducts((err, products) => {
    if (err) return res.status(500).send('Database error');
    res.render('shopping', { user: req.session.user, products });
  });
});

app.post('/add-to-cart/:id', checkAuthenticated, CartController.addItem);
app.post('/cart/add/:productId', checkAuthenticated, CartController.addItem); // alias
app.post('/cart/update/:id', checkAuthenticated, CartController.updateQuantity);
app.post('/cart/remove/:id', checkAuthenticated, CartController.removeItem);
app.get('/cart', checkAuthenticated, CartController.viewCart);
app.get('/checkout', checkAuthenticated, CartController.viewCheckout);
app.post('/checkout', checkAuthenticated, CartController.processCheckout);

// User order history
app.get('/my-orders', checkAuthenticated, (req, res) => {
  OrderModel.getOrdersByUser(req.session.user.id, (err, orders) => {
    if (err) {
      console.error('DB error:', err);
      req.flash('error', 'Unable to load your orders.');
      return res.render('orderHistory', { orders: [], user: req.session.user });
    }
    res.render('orderHistory', { orders: orders || [], user: req.session.user });
  });
});

app.get('/product/:id', checkAuthenticated, (req, res) => {
  const productId = parseInt(req.params.id, 10);
  ProductModel.getProductById(productId, (err, product) => {
    if (err) return res.status(500).send('Database error');
    if (!product) return res.status(404).send('Product not found');
    res.render('product', { product, user: req.session.user });
  });
});

// Add / update / delete product (view flows) use model + multer
app.get('/addProduct', checkAuthenticated, checkAdmin, (req, res) => res.render('addProduct', { user: req.session.user }));

app.post('/addProduct', checkAuthenticated, checkAdmin, upload.single('image'), (req, res) => {
  const { name, quantity, price, category, customCategory } = req.body;
  const chosenCategory = (category === 'Other' ? (customCategory || '') : category) || 'Uncategorized';
  const image = req.file ? req.file.filename : null;
  const product = { productName: name, quantity: Number(quantity), price: Number(price), image, category: chosenCategory || null };
  ProductModel.addProduct(product, (err) => {
    if (err) return res.status(500).send('Error adding product');
    res.redirect('/inventory');
  });
});

app.get('/updateProduct/:id', checkAuthenticated, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  ProductModel.getProductById(id, (err, product) => {
    if (err) return res.status(500).send('Database error');
    if (!product) return res.status(404).send('Product not found');
    res.render('updateProduct', { product, user: req.session.user });
  });
});

app.post('/updateProduct/:id', checkAuthenticated, checkAdmin, upload.single('image'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, quantity, price, currentImage, category, customCategory } = req.body;
  const chosenCategory = (category === 'Other' ? (customCategory || '') : category) || 'Uncategorized';
  const image = req.file ? req.file.filename : (currentImage || null);
  const product = { productName: name, quantity: Number(quantity), price: Number(price), image, category: chosenCategory || null };
  ProductModel.updateProduct(id, product, (err) => {
    if (err) return res.status(500).send('Error updating product');
    res.redirect('/inventory');
  });
});

// Admin dashboards
app.get('/orders', checkAuthenticated, checkAdmin, (req, res) => {
  OrderModel.getAllOrders((err, orders) => {
    if (err) {
      console.error('DB error:', err);
      req.flash('error', 'Unable to load orders.');
      return res.render('orderDashboard', { orders: [], user: req.session.user });
    }
    res.render('orderDashboard', { orders: orders || [], user: req.session.user });
  });
});

app.get('/users', checkAuthenticated, checkAdmin, (req, res) => {
  UserModel.getAllUsers((err, users) => {
    if (err) {
      console.error('DB error:', err);
      req.flash('error', 'Unable to load users.');
      return res.render('userDashboard', { users: [], user: req.session.user });
    }
    res.render('userDashboard', { users: users || [], user: req.session.user });
  });
});

app.get('/orders/:id/edit', checkAuthenticated, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    req.flash('error', 'Invalid order id.');
    return res.redirect('/orders');
  }
  OrderModel.getOrderById(id, (err, order) => {
    if (err) {
      console.error('DB error:', err);
      req.flash('error', 'Unable to load order.');
      return res.redirect('/orders');
    }
    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/orders');
    }
    res.render('editOrder', { order, user: req.session.user });
  });
});

app.post('/orders/:id/edit', checkAuthenticated, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    req.flash('error', 'Invalid order id.');
    return res.redirect('/orders');
  }
  const { userId, totalAmount, status } = req.body;
  const orderData = {
    userId: userId != null ? Number(userId) : undefined,
    totalAmount: totalAmount != null ? Number(totalAmount) : undefined,
    status
  };
  OrderModel.updateOrder(id, orderData, undefined, (err, result) => {
    if (err) {
      console.error('DB error:', err);
      req.flash('error', 'Unable to update order.');
      return res.redirect(`/orders/${id}/edit`);
    }
    if (!result) {
      req.flash('error', 'Order not found.');
      return res.redirect('/orders');
    }
    req.flash('success', 'Order updated.');
    res.redirect('/orders');
  });
});

app.get('/invoice/:id', checkAuthenticated, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).send('Invalid order id');

  OrderModel.getOrderById(id, (err, order) => {
    if (err) {
      console.error('DB error:', err);
      return res.status(500).send('Database error');
    }
    if (!order) return res.status(404).send('Order not found');

    // Only allow owner or admin to view
    if (req.session.user.role !== 'admin' && order.userId !== req.session.user.id) {
      req.flash('error', 'Access denied.');
      return res.redirect('/shopping');
    }

    const checkout = {
      fullName: req.session.user.username || '',
      email: req.session.user.email || '',
      address: req.session.user.address || '',
      contact: req.session.user.contact || ''
    };

    res.render('invoice', { order, orderId: order.id, checkout, user: req.session.user });
  });
});

app.post('/orders/:id/delete', checkAuthenticated, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    req.flash('error', 'Invalid order id.');
    return res.redirect('/orders');
  }
  OrderModel.deleteOrder(id, (err, result) => {
    if (err) {
      console.error('DB error:', err);
      req.flash('error', 'Unable to delete order.');
      return res.redirect('/orders');
    }
    if (!result) {
      req.flash('error', 'Order not found.');
      return res.redirect('/orders');
    }
    req.flash('success', 'Order deleted.');
    res.redirect('/orders');
  });
});

app.get('/users/:id/edit', checkAuthenticated, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    req.flash('error', 'Invalid user id.');
    return res.redirect('/users');
  }
  UserModel.getUserById(id, (err, editUser) => {
    if (err) {
      console.error('DB error:', err);
      req.flash('error', 'Unable to load user.');
      return res.redirect('/users');
    }
    res.render('editUser', { editUser, user: req.session.user });
  });
});

app.post('/users/:id/edit', checkAuthenticated, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    req.flash('error', 'Invalid user id.');
    return res.redirect('/users');
  }
  const { username, email, address, contact, role, password } = req.body;
  UserModel.getUserById(id, (findErr, existing) => {
    if (findErr || !existing) {
      if (findErr) console.error('DB error:', findErr);
      req.flash('error', 'User not found.');
      return res.redirect('/users');
    }
    const updated = {
      username: username || existing.username,
      email: email || existing.email,
      password: password ? crypto.createHash('sha1').update(password).digest('hex') : existing.password,
      address: address || existing.address,
      contact: contact || existing.contact,
      role: role || existing.role
    };
    UserModel.updateUser(id, updated, (err) => {
      if (err) {
        console.error('DB error:', err);
        req.flash('error', 'Unable to update user.');
        return res.redirect(`/users/${id}/edit`);
      }
      req.flash('success', 'User updated.');
      res.redirect('/users');
    });
  });
});

app.get('/deleteProduct/:id', checkAuthenticated, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  ProductModel.deleteProduct(id, (err) => {
    if (err) return res.status(500).send('Error deleting product');
    res.redirect('/inventory');
  });
});

app.post('/users/:id/delete', checkAuthenticated, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    req.flash('error', 'Invalid user id.');
    return res.redirect('/users');
  }
  UserModel.deleteUser(id, (err) => {
    if (err) {
      console.error('DB error:', err);
      req.flash('error', 'Unable to delete user.');
      return res.redirect('/users');
    }
    req.flash('success', 'User deleted.');
    res.redirect('/users');
  });
});

// ----------------- API routes (use controllers) -----------------

// Users (RESTful API)
app.get('/api/users', UserController.listUsers);
app.get('/api/users/:id', UserController.getUser);
app.post('/api/users', upload.single('image'), UserController.createUser); // optional file in req.file
app.put('/api/users/:id', upload.single('image'), UserController.updateUser);
app.delete('/api/users/:id', UserController.deleteUser);

// Products (RESTful API)
app.get('/api/products', ProductController.listProducts);
app.get('/api/products/:id', ProductController.getProduct);
app.post('/api/products', upload.single('image'), ProductController.createProduct);
app.put('/api/products/:id', upload.single('image'), ProductController.updateProduct);
app.delete('/api/products/:id', ProductController.deleteProduct);

// --- start server ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
