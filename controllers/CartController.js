const CartModel = require('../models/cart');
const ProductModel = require('../models/product');
const OrderModel = require('../models/order');

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

      OrderModel.getOrdersByUser(userId, (orderErr, orders) => {
        if (orderErr) {
          console.error('Error checking orders:', orderErr);
          req.flash('error', 'Unable to load checkout right now.');
          return res.redirect('/shopping');
        }

        const { cart, cartTotal } = mapCartItems(items);
        const discountEligible = !orders || orders.length === 0;
        const discountedTotal = discountEligible ? Number((cartTotal * 0.75).toFixed(2)) : cartTotal;

        res.render('checkout', {
          cart,
          cartTotal,
          discountedTotal,
          discountEligible,
          user: req.session.user,
          formData: req.flash('formData')[0]
        });
      });
    });
  },

  processCheckout(req, res) {
    if (!req.session?.user) {
      req.flash('error', 'Please log in to checkout.');
      return res.redirect('/login');
    }

    const { fullName, address, contact, email, cardNumber, expiry, cvv } = req.body;
    const errors = [];

    if (!fullName) errors.push('Full name is required.');
    if (!address) errors.push('Delivery address is required.');
    if (!contact || !/^\+?\d{7,15}$/.test(contact.trim())) errors.push('Contact number must be 7-15 digits (may start with +).');
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) errors.push('A valid email is required (e.g., mary@mary.com).');
    if (!cardNumber || !/^\d{16}$/.test(cardNumber.trim())) errors.push('Card number must be exactly 16 digits.');
    if (!cvv || !/^\d{3,4}$/.test(cvv.trim())) errors.push('CVV must be 3-4 digits.');
    if (!expiry || !/^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry.trim())) {
      errors.push('Expiry must be in MM/YY format.');
    } else {
      const [mm, yy] = expiry.split('/');
      const month = parseInt(mm, 10);
      const year = 2000 + parseInt(yy, 10);
      const now = new Date();
      const expDate = new Date(year, month);
      if (expDate <= now) errors.push('Card has expired.');
    }

    if (errors.length) {
      req.flash('error', errors);
      req.flash('formData', req.body);
      return res.redirect('/checkout');
    }

    const userId = req.session.user.id;
    CartModel.getCartByUser(userId, (err, items) => {
      if (err) {
        console.error('Error fetching cart:', err);
        req.flash('error', 'Unable to complete checkout right now.');
        return res.redirect('/cart');
      }
      if (!items || items.length === 0) {
        req.flash('error', 'Your cart is empty.');
        return res.redirect('/cart');
      }

        const { cart, cartTotal } = mapCartItems(items);

        OrderModel.getOrdersByUser(userId, (orderFetchErr, existingOrders) => {
          if (orderFetchErr) {
            console.error('Error checking existing orders:', orderFetchErr);
            req.flash('error', 'Unable to complete checkout right now.');
            return res.redirect('/cart');
          }

          const isFirstOrder = !existingOrders || existingOrders.length === 0;
          const discountPercent = isFirstOrder ? 25 : 0;
          const discountedTotal = discountPercent > 0 ? Number((cartTotal * 0.75).toFixed(2)) : cartTotal;
          const discountAmount = Math.max(0, Number((cartTotal - discountedTotal).toFixed(2)));

          const orderItems = cart.map((item) => ({
            productId: item.productId,
            quantity: Number(item.quantity),
            price: item.discountedPrice,
            productName: item.productName,
            image: item.image
          }));

        const checkoutDetails = {
          fullName: fullName || req.session.user.username || '',
          address: address || req.session.user.address || '',
          contact: contact || req.session.user.contact || '',
          email: email || req.session.user.email || '',
          discountApplied: discountPercent > 0 ? '25% first order discount applied' : ''
        };

        const payload = {
          userId,
          totalAmount: discountedTotal,
          discountPercent,
          status: 'processing'
        };

        OrderModel.createOrder(payload, orderItems, (orderErr, result) => {
          if (orderErr) {
            console.error('Error creating order:', orderErr);
            req.flash('error', 'Unable to place order.');
            return res.redirect('/cart');
          }

          const renderInvoice = (orderData) => {
            CartModel.clearCartByUser(userId, (clearErr) => {
              if (clearErr) console.error('Error clearing cart after checkout:', clearErr);
              res.render('invoice', {
                order: orderData,
                orderId: orderData && orderData.id ? orderData.id : result.orderId,
                checkout: checkoutDetails,
                discountAmount,
                user: req.session.user
              });
            });
          };

        const updateStock = () => {
          const tasks = orderItems.map((item) => new Promise((resolve, reject) => {
            ProductModel.decrementQuantity(item.productId, item.quantity, (decErr, result) => {
              if (decErr) {
                console.error('Error decrementing stock', decErr);
                return reject(decErr);
              }
              // If no rows were updated, surface as an error to avoid silently skipping.
              if (result && result.affectedRows === 0) {
                const errMsg = `No stock updated for product ${item.productId}`;
                console.error(errMsg);
                return reject(new Error(errMsg));
              }
              resolve();
            });
          }));
          return Promise.all(tasks);
        };

          OrderModel.getOrderById(result.orderId, (fetchErr, order) => {
            if (fetchErr || !order) {
              // Fallback if fetch fails
              const fallbackOrder = {
                id: result.orderId,
                userId,
                totalAmount: discountedTotal,
                status: 'processing',
                items: orderItems
              };
              return updateStock()
                .catch((err) => console.error('Stock update error:', err))
                .finally(() => renderInvoice(fallbackOrder));
            }

            const enriched = {
              ...order,
              totalAmount: discountedTotal,
              items: order.items.map((it) => {
                const fromCart = orderItems.find((ci) => ci.productId === it.productId);
                return {
                  ...it,
                  productName: it.productName || (fromCart && fromCart.productName) || '',
                  image: it.image || (fromCart && fromCart.image) || ''
                };
              })
            };
            updateStock()
              .catch((err) => console.error('Stock update error:', err))
              .finally(() => renderInvoice(enriched));
          });
        });
      });
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

      CartModel.getCartItemByProduct(req.session.user.id, productId, (cartItemErr, cartItem) => {
        if (cartItemErr) {
          console.error('Error checking cart item:', cartItemErr);
          req.flash('error', 'Unable to add item to cart.');
          return res.redirect(backUrl);
        }
        if (cartItem && cartItem.missingTable) {
          req.flash('error', 'Cart storage is unavailable. Please ensure the cart_items table exists.');
          return res.redirect(backUrl);
        }

        const currentQty = cartItem ? Number(cartItem.quantity) : 0;
        const desiredTotal = currentQty + quantity;
        if (desiredTotal > product.quantity) {
          req.flash('error', `Only ${product.quantity} in stock. Please reduce quantity.`);
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

    CartModel.getCartItemWithProduct(req.session.user.id, itemId, (itemErr, cartItem) => {
      if (itemErr) {
        console.error('Error loading cart item:', itemErr);
        req.flash('error', 'Unable to update quantity.');
        return res.redirect('/cart');
      }
      if (cartItem && cartItem.missingTable) {
        req.flash('error', 'Cart storage is unavailable. Please ensure the cart_items table exists.');
        return res.redirect('/cart');
      }
      if (!cartItem) {
        req.flash('error', 'Cart item not found.');
        return res.redirect('/cart');
      }
      if (quantity > cartItem.productStock) {
        req.flash('error', `Only ${cartItem.productStock} in stock. Please reduce quantity.`);
        return res.redirect('/cart');
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
