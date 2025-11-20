const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const crypto = require('crypto');

const ProductModel = require('./models/product');
const UserModel = require('./models/user');
const ProductController = require('./controllers/ProductController');
const UserController = require('./controllers/UserController');
const CartController = require('./controllers/CartController');

const app = express();

// --- Multer for uploads (product images / optional user pictures) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/images'),
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

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
  const { username, email, password, address, contact, role } = req.body;
  if (!username || !email || !password || !address || !contact || !role) {
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
  const { username, email, password, address, contact, role } = req.body;
  const hashed = crypto.createHash('sha1').update(password).digest('hex');
  const user = { username, email, password: hashed, address, contact, role };

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
    req.session.user = found;
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
  const { name, quantity, price } = req.body;
  const image = req.file ? req.file.filename : null;
  const product = { productName: name, quantity: Number(quantity), price: Number(price), image };
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
  const { name, quantity, price, currentImage } = req.body;
  const image = req.file ? req.file.filename : (currentImage || null);
  const product = { productName: name, quantity: Number(quantity), price: Number(price), image };
  ProductModel.updateProduct(id, product, (err) => {
    if (err) return res.status(500).send('Error updating product');
    res.redirect('/inventory');
  });
});

app.get('/deleteProduct/:id', checkAuthenticated, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  ProductModel.deleteProduct(id, (err) => {
    if (err) return res.status(500).send('Error deleting product');
    res.redirect('/inventory');
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
