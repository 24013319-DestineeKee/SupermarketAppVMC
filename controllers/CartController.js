const CartModel = require('../models/cart');
const ProductModel = require('../models/product');

const parsePositiveInt = (value) => {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const mapCartItems = (items) => {
  const cart = items.map((item) => {
    const discount = Number(item.discount) || 0;
    const quantity = Number(item.quantity) || 0;
    const unitPrice = Number(item.price) || 0;
    const discountedPrice = unitPrice * (1 - discount / 100);
    const lineTotal = discountedPrice * quantity;
    return {
      ...item,
      discount,
      quantity,
      unitPrice,
      discountedPrice,
      lineTotal
    };
  });

  const cartTotal = cart.reduce((sum, item) => sum + item.lineTotal, 0);
  return { cart, cartTotal };
};

const CartController = {
  viewCart(req, res) {
    if (!req.session?.user) {
      req.flash('error', 'Please log in to view your cart.');
      return res.redirect('/login');
    }

    const userId = req.session.user.id;
    CartModel.getCartByUser(userId, (err, items) => {
      if (err) {
        console.error('Error fetching cart:', err);
        req.flash('error', 'Unable to load cart at the moment.');
        return res.redirect('/shopping');
      }

      const { cart, cartTotal } = mapCartItems(items);
      res.render('cart', { cart, cartTotal, user: req.session.user });
    });
  },

  viewCheckout(req, res) {
    if (!req.session?.user) {
      req.flash('error', 'Please log in to checkout.');
      return res.redirect('/login');
    }

    const userId = req.session.user.id;
    CartModel.getCartByUser(userId, (err, items) => {
      if (err) {
        console.error('Error fetching cart:', err);
        req.flash('error', 'Unable to load checkout right now.');
        return res.redirect('/shopping');
      }

      const { cart, cartTotal } = mapCartItems(items);
      res.render('checkout', { cart, cartTotal, user: req.session.user });
    });
  },

  addItem(req, res) {
    if (!req.session?.user) {
      req.flash('error', 'Please log in to add items.');
      return res.redirect('/login');
    }

    let backUrl = '/shopping';
    const referer = req.get('referer');
    if (referer) {
      try {
        const parsed = new URL(referer);
        backUrl = parsed.pathname + (parsed.search || '') || backUrl;
      } catch (parseErr) {
        // ignore parse errors and keep default backUrl
      }
    }
    const productId = parsePositiveInt(req.params.id || req.params.productId);
    const quantity = parsePositiveInt(req.body.quantity) || 1;
    if (!productId) {
      req.flash('error', 'Invalid product.');
      return res.redirect(backUrl);
    }

    ProductModel.getProductById(productId, (err, product) => {
      if (err) {
        console.error('Error fetching product:', err);
        req.flash('error', 'Unable to add item right now.');
        return res.redirect(backUrl);
      }
      if (!product) {
        req.flash('error', 'Product not found.');
        return res.redirect(backUrl);
      }

      CartModel.addOrUpdateItem(req.session.user.id, productId, quantity, (cartErr, info) => {
        if (cartErr) {
          console.error('Error adding to cart:', cartErr);
          req.flash('error', 'Unable to add item to cart.');
          return res.redirect(backUrl);
        }
        if (info && info.missingTable) {
          req.flash('error', 'Cart storage is unavailable. Please ensure the cart_items table exists.');
          return res.redirect(backUrl);
        }
        req.flash('success', 'Item added to cart.');
        return res.redirect(backUrl);
      });
    });
  },

  updateQuantity(req, res) {
    if (!req.session?.user) {
      req.flash('error', 'Please log in to update your cart.');
      return res.redirect('/login');
    }

    const itemId = parsePositiveInt(req.params.id || req.params.itemId);
    const qtyRaw = parseInt(req.body.quantity, 10);
    const quantity = Number.isInteger(qtyRaw) ? qtyRaw : null;
    if (!itemId || quantity == null || quantity < 0) {
      req.flash('error', 'Invalid cart item or quantity.');
      return res.redirect('/cart');
    }

    if (quantity === 0) {
      CartModel.removeItem(req.session.user.id, itemId, (err) => {
        if (err) {
          console.error('Error removing item:', err);
          req.flash('error', 'Unable to remove item.');
          return res.redirect('/cart');
        }
        req.flash('success', 'Item removed.');
        return res.redirect('/cart');
      });
      return;
    }

    CartModel.updateQuantity(req.session.user.id, itemId, quantity, (err, info) => {
      if (err) {
        console.error('Error updating quantity:', err);
        req.flash('error', 'Unable to update quantity.');
        return res.redirect('/cart');
      }
      if (info && info.missingTable) {
        req.flash('error', 'Cart storage is unavailable. Please ensure the cart_items table exists.');
        return res.redirect('/cart');
      }
      req.flash('success', 'Cart updated.');
      return res.redirect('/cart');
    });
  },

  removeItem(req, res) {
    if (!req.session?.user) {
      req.flash('error', 'Please log in to update your cart.');
      return res.redirect('/login');
    }

    const itemId = parsePositiveInt(req.params.id || req.params.itemId);
    if (!itemId) {
      req.flash('error', 'Invalid cart item.');
      return res.redirect('/cart');
    }

    CartModel.removeItem(req.session.user.id, itemId, (err) => {
      if (err) {
        console.error('Error removing item:', err);
        req.flash('error', 'Unable to remove item.');
        return res.redirect('/cart');
      }
      req.flash('success', 'Item removed.');
      return res.redirect('/cart');
    });
  }
};

module.exports = CartController;
