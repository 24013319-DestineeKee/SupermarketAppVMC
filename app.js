const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');

const ProductModel = require('./models/product');
const UserModel = require('./models/user');
const OrderModel = require('./models/order');
const RefundModel = require('./models/refund');
const MembershipModel = require('./models/membership');
const RefundCreditModel = require('./models/refundCredit');
const ProductController = require('./controllers/ProductController');
const UserController = require('./controllers/UserController');
const CartController = require('./controllers/CartController');
const NetsController = require('./controllers/NetsController');
const RefundController = require('./controllers/RefundController');

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

// Separate storage for refund evidence
const reportStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const dir = RefundController.ensureUploadsDir();
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_');
    cb(null, `${base}-${Date.now()}${ext.toLowerCase()}`);
  }
});
const reportUpload = multer({
  storage: reportStorage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/png', 'image/jpeg'];
    const ext = (path.extname(file.originalname || '').toLowerCase() || '');
    const allowedExt = ['.png', '.jpg', '.jpeg'];
    if (!allowedTypes.includes(file.mimetype) || !allowedExt.includes(ext)) {
      return cb(new Error('Only PNG or JPG images are allowed'));
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

// helper to enrich user with a displayName
const enrichUser = (user) => {
  if (!user) return null;
  return { ...user, displayName: user.username || user.email };
};

// normalize price to two decimals; returns null if invalid/<=0
const normalizePrice = (raw) => {
  const num = Number.parseFloat(raw);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Number(num.toFixed(2));
};

// expose flash messages to all views as `messages`
app.use((req, res, next) => {
  if (req.session && req.session.user) {
    req.session.user = enrichUser(req.session.user);
  }
  res.locals.messages = {
    success: req.flash('success') || [],
    error: req.flash('error') || [],
    warning: req.flash('warning') || []
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
  res.render('register', {
    messages: req.flash('success') || [],
    errors: req.flash('error') || [],
    formData: req.flash('formData')[0] || {}
  });
});

app.post('/register', (req, res) => {
  const { username, email, password, address, contact, joinMembership } = req.body;
  const errors = [];
  if (!username) errors.push('Username is required.');
  if (!email) {
    errors.push('Email is required.');
  } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    errors.push('A valid email is required (e.g., name@example.com).');
  }
  if (!password) errors.push('Password is required.');
  if (password && password.length < 6) errors.push('Password should be at least 6 characters.');
  if (!address) errors.push('Address is required.');
  if (!contact) errors.push('Contact is required.');
  if (contact && !/^\d{8}$/.test(contact.trim())) errors.push('Contact number must be exactly 8 digits.');

  if (errors.length) {
    return res.status(400).render('register', {
      messages: [],
      errors,
      formData: { username: username || '', email: email || '', address: address || '', contact: contact || '' }
    });
  }

  const hashed = crypto.createHash('sha1').update(password).digest('hex');
  const user = { username, email, password: hashed, address, contact, role: 'user' };

  // Use model to add user and then redirect (controller API exists for JSON; keep view UX here)
  UserModel.addUser(user, (err) => {
    if (err) {
      console.error('Error adding user:', err);
      return res.status(500).render('register', {
        messages: [],
        errors: ['Registration failed. Please try again.'],
        formData: { username, email, address, contact }
      });
    }
    if (joinMembership === 'on') {
      const MembershipModel = require('./models/membership');
      MembershipModel.createForUser(user.id || null, () => {
        req.flash('success', 'Registration successful! Membership will be activated after first login.');
        res.redirect('/login');
      });
    } else {
      req.flash('success', 'Registration successful! Please log in.');
      res.redirect('/login');
    }
  });
});

app.get('/login', (req, res) => {
  res.render('login', {
    messages: req.flash('success') || [],
    errors: req.flash('error') || [],
    formData: req.flash('formData')[0] || {}
  });
});

// Profile (user self-service)
app.get('/profile', checkAuthenticated, (req, res) => {
  const userId = req.session.user.id;
  UserModel.getUserById(userId, (err, profileUser) => {
    if (err) {
      console.error('DB error:', err);
      req.flash('error', 'Unable to load profile.');
      return res.redirect('/shopping');
    }
    if (!profileUser) {
      req.flash('error', 'User not found.');
      return res.redirect('/logout');
    }
    MembershipModel.getByUser(userId, (mErr, membership) => {
      if (mErr) {
        console.error('Error loading membership for profile', mErr);
        membership = null;
      }
      if (req.session && req.session.user) {
        req.session.user.membership = !!membership;
      }
      res.render('profile', { user: req.session.user, profileUser, membership });
    });
  });
});

app.post('/profile', checkAuthenticated, (req, res) => {
  const id = req.session.user.id;
  const { username, email, password, address, contact, currentPassword } = req.body;

  if (!username || !email || !address || !contact) {
    req.flash('error', 'Username, email, address, and contact are required.');
    return res.redirect('/profile');
  }
  if (password && password.length < 6) {
    req.flash('error', 'New password should be at least 6 characters.');
    return res.redirect('/profile');
  }
  if (contact && !/^\d{8}$/.test(contact.trim())) {
    req.flash('error', 'Contact number must be exactly 8 digits.');
    return res.redirect('/profile');
  }

  UserModel.getUserById(id, (findErr, existing) => {
    if (findErr || !existing) {
      if (findErr) console.error('DB error:', findErr);
      req.flash('error', 'User not found.');
      return res.redirect('/logout');
    }

    const hasChanges = (
      username !== existing.username ||
      email !== existing.email ||
      (address || '') !== (existing.address || '') ||
      (contact || '') !== (existing.contact || '') ||
      !!password
    );

    if (!hasChanges) {
      req.flash('error', 'No changes detected.');
      return res.redirect('/profile');
    }

    if (!currentPassword) {
      req.flash('error', 'Please enter your current password to save changes.');
      return res.redirect('/profile');
    }

    const currentHashed = crypto.createHash('sha1').update(currentPassword).digest('hex');
    if (currentHashed !== existing.password) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect('/profile');
    }

    const updated = {
      username,
      email,
      password: password ? crypto.createHash('sha1').update(password).digest('hex') : existing.password,
      address: address || '',
      contact: contact || '',
      role: existing.role
    };

    UserModel.updateUser(id, updated, (err) => {
      if (err) {
        console.error('DB error:', err);
        req.flash('error', 'Unable to update profile.');
        return res.redirect('/profile');
      }
      UserModel.getUserById(id, (refreshErr, freshUser) => {
        if (refreshErr || !freshUser) {
          if (refreshErr) console.error('DB error:', refreshErr);
          req.flash('success', 'Profile updated.');
          return res.redirect('/profile');
        }
        req.session.user = enrichUser(freshUser);
        req.flash('success', 'Profile updated.');
        res.redirect('/profile');
      });
    });
  });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const errors = [];
  if (!email) {
    errors.push('Email is required.');
  } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    errors.push('A valid email is required (e.g., name@example.com).');
  }
  if (!password) errors.push('Password is required.');
  if (errors.length) {
    return res.status(400).render('login', { messages: [], errors, formData: { email: email || '' } });
  }
  const hashed = crypto.createHash('sha1').update(password).digest('hex');

  // Use model to find the user
  UserModel.getAllUsers((err, users) => {
    if (err) {
      console.error('DB error:', err);
      return res.status(500).render('login', { messages: [], errors: ['Login failed. Please try again.'], formData: { email } });
    }
    const found = users.find(u => u.email === email && u.password === hashed);
    if (!found) {
      return res.status(401).render('login', { messages: [], errors: ['Invalid email or password.'], formData: { email } });
    }
    // Preserve the stored username for display.
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
  const userId = req.session.user.id;
  ProductModel.getAllProducts((err, products) => {
    if (err) return res.status(500).send('Database error');
    MembershipModel.getByUser(userId, (mErr, membership) => {
      if (mErr) {
        console.error('Error loading membership for shopping view', mErr);
        membership = null;
      }
      if (req.session && req.session.user) {
        req.session.user.membership = !!membership;
      }
      RefundCreditModel.getLatestAvailableByUser(userId, (cErr, credit) => {
        if (cErr) console.error('Error loading refund credit for shopping', cErr);
        const availableCredit = credit && Number(credit.amount) ? Number(credit.amount) : 0;
        res.render('shopping', {
          user: req.session.user,
          products,
          membership,
          loyaltyRedemption: req.session.loyaltyRedemption || null,
          refundCreditAmount: availableCredit
        });
      });
    });
  });
});

app.post('/add-to-cart/:id', checkAuthenticated, CartController.addItem);
app.post('/cart/add/:productId', checkAuthenticated, CartController.addItem); // alias
app.post('/cart/update/:id', checkAuthenticated, CartController.updateQuantity);
app.post('/cart/remove/:id', checkAuthenticated, CartController.removeItem);
app.get('/cart', checkAuthenticated, CartController.viewCart);
app.get('/checkout', checkAuthenticated, CartController.viewCheckout);
app.post('/checkout', checkAuthenticated, CartController.processCheckout);
app.post('/api/paypal/create-order', checkAuthenticated, CartController.createPaypalOrder);
app.post('/api/paypal/capture-order', checkAuthenticated, CartController.capturePaypalOrder);
app.post('/nets/qr', checkAuthenticated, NetsController.generateQrCode);
app.get('/nets/qr/fail', checkAuthenticated, NetsController.fail.bind(NetsController));
app.post('/nets/confirm', checkAuthenticated, NetsController.confirmPayment.bind(NetsController));
app.post('/api/stripe/create-intent', checkAuthenticated, CartController.createStripePaymentIntent);
app.post('/api/stripe/confirm-payment', checkAuthenticated, CartController.confirmStripePayment);
app.get('/orders/:id/report', checkAuthenticated, RefundController.reportForm.bind(RefundController));
app.post('/orders/:id/report', checkAuthenticated, reportUpload.single('evidence'), RefundController.ensureRequiredFields.bind(RefundController), RefundController.submitReport.bind(RefundController));
app.get('/refunds', checkAuthenticated, checkAdmin, RefundController.listReports.bind(RefundController));
app.get('/refunds/:id', checkAuthenticated, checkAdmin, RefundController.viewReport.bind(RefundController));
app.post('/refunds/:id/resolve', checkAuthenticated, checkAdmin, RefundController.resolveReport.bind(RefundController));
app.get('/my-refunds/:orderId', checkAuthenticated, RefundController.viewUserReport.bind(RefundController));
app.get('/membership', checkAuthenticated, (req, res) => {
  res.redirect('/profile');
});
app.post('/membership/join', checkAuthenticated, (req, res) => {
  MembershipModel.createForUser(req.session.user.id, (err) => {
    if (err) {
      console.error('Error joining membership', err);
      req.flash('error', 'Unable to join membership.');
      return res.redirect('/membership');
    }
    req.flash('success', 'Membership activated. Earn points on every purchase.');
    res.redirect('/shopping');
  });
});

app.post('/membership/redeem', checkAuthenticated, CartController.redeemLoyalty);

// User order history
app.get('/my-orders', checkAuthenticated, (req, res) => {
  OrderModel.getOrdersByUser(req.session.user.id, (err, orders) => {
    if (err) {
      console.error('DB error:', err);
      req.flash('error', 'Unable to load your orders.');
      return res.render('orderHistory', { orders: [], user: req.session.user });
    }
    const orderIds = (orders || []).map((o) => o.id);
    RefundModel.getReportsByOrderIds(orderIds, (rErr, reportsMap) => {
      if (rErr) console.error('Refund map error:', rErr);
      const hydrated = (orders || []).map((o) => ({
        ...o,
        refund: reportsMap ? reportsMap[o.id] : null
      }));
      res.render('orderHistory', { orders: hydrated, user: req.session.user });
    });
  });
});

app.post('/orders/:id/complete', checkAuthenticated, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    req.flash('error', 'Invalid order id.');
    return res.redirect('/my-orders');
  }
  OrderModel.getOrderById(id, (err, order) => {
    if (err) {
      console.error('DB error:', err);
      req.flash('error', 'Unable to update order.');
      return res.redirect('/my-orders');
    }
    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/my-orders');
    }
    // only owner or admin may complete
    if (req.session.user.role !== 'admin' && order.userId !== req.session.user.id) {
      req.flash('error', 'Access denied.');
      return res.redirect('/my-orders');
    }
    OrderModel.updateStatus(id, 'completed', (updateErr) => {
      if (updateErr) {
        console.error('DB error:', updateErr);
        req.flash('error', 'Unable to mark as completed.');
        return res.redirect('/my-orders');
      }
      req.flash('success', 'Order marked as completed.');
      res.redirect('/my-orders');
    });
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
  const priceNum = normalizePrice(price);
  if (priceNum == null) {
    req.flash('error', 'Price must be a positive number.');
    return res.redirect('/addProduct');
  }
  const chosenCategory = (category === 'Other' ? (customCategory || '') : category) || 'Uncategorized';
  const image = req.file ? req.file.filename : '';
  const product = { productName: name, quantity: Number(quantity), price: priceNum, image, category: chosenCategory || null };
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
  const priceNum = normalizePrice(price);
  if (priceNum == null) {
    req.flash('error', 'Price must be a positive number.');
    return res.redirect(`/updateProduct/${id}`);
  }
  const chosenCategory = (category === 'Other' ? (customCategory || '') : category) || 'Uncategorized';
  const image = req.file ? req.file.filename : (currentImage || '');
  const product = { productName: name, quantity: Number(quantity), price: priceNum, image, category: chosenCategory || null };
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
    const orderIds = (orders || []).map((o) => o.id);
    RefundModel.getReportsByOrderIds(orderIds, (rErr, reportsMap) => {
      if (rErr) console.error('Refund map error:', rErr);
      const hydrated = (orders || []).map((o) => ({
        ...o,
        refund: reportsMap ? reportsMap[o.id] : null
      }));
      res.render('orderDashboard', { orders: hydrated || [], user: req.session.user });
    });
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

    // Compute discount amount based on items vs total
    let discountAmount = 0;
    if (order && order.items && order.items.length) {
      const subtotal = order.items.reduce((sum, item) => {
        const price = Number(item.price || 0);
        const qty = Number(item.quantity || 0);
        return sum + price * qty;
      }, 0);
      const total = Number(order.totalAmount || 0);
      const diff = subtotal - total;
      if (diff > 0.009) discountAmount = Number(diff.toFixed(2));
    }

    const effectiveDiscount = (() => {
      if (order && order.discountPercent != null) {
        const percent = Number(order.discountPercent);
        if (order.items && order.items.length) {
          const subtotal = order.items.reduce((sum, item) => {
            const price = Number(item.price || 0);
            const qty = Number(item.quantity || 0);
            return sum + price * qty;
          }, 0);
          const diff = subtotal * (percent / 100);
          return Number(diff.toFixed(2));
        }
      }
      return discountAmount || 0;
    })();

    res.render('invoice', { order, orderId: order.id, checkout, discountAmount: effectiveDiscount, user: req.session.user });
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
app.post('/api/users', UserController.createUser);
app.put('/api/users/:id', UserController.updateUser);
app.delete('/api/users/:id', UserController.deleteUser);
app.post('/membership/toggle', checkAuthenticated, UserController.toggleMembership);

// Products (RESTful API)
app.get('/api/products', ProductController.listProducts);
app.get('/api/products/:id', ProductController.getProduct);
app.post('/api/products', upload.single('image'), ProductController.createProduct);
app.put('/api/products/:id', upload.single('image'), ProductController.updateProduct);
app.delete('/api/products/:id', ProductController.deleteProduct);

// --- start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
