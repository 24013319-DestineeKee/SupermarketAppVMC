const CartModel = require('../models/cart');
const ProductModel = require('../models/product');
const OrderModel = require('../models/order');
const PaypalService = require('../services/paypal');
const StripeService = require('../services/stripe');
const MembershipModel = require('../models/membership');
const RefundCreditModel = require('../models/refundCredit');

const buildLocalTransactionId = (prefix = 'CARD') => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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

const computeLoyaltyUsage = (loyaltyRedemption, subtotal) => {
  if (!loyaltyRedemption || !Number.isFinite(subtotal) || subtotal <= 0) {
    return { pointsUsed: 0, discountAmount: 0 };
  }
  const requestedPoints = Math.floor(Number(loyaltyRedemption.points) || 0);
  if (!requestedPoints || requestedPoints <= 0) {
    return { pointsUsed: 0, discountAmount: 0 };
  }
  const maxPointsForTotal = Math.max(0, Math.floor(subtotal * 10 + Number.EPSILON) - 1);
  const applicablePoints = Math.min(requestedPoints, maxPointsForTotal);
  if (!applicablePoints) {
    return { pointsUsed: 0, discountAmount: 0 };
  }
  return {
    pointsUsed: applicablePoints,
    discountAmount: Number((applicablePoints / 10).toFixed(2))
  };
};

const validateContactDetails = (payload = {}) => {
  const { fullName, address, contact, email } = payload;
  const errors = [];

  if (!fullName) errors.push('Full name is required.');
  if (!address) errors.push('Delivery address is required.');
  if (!contact || !/^\+?\d{7,15}$/.test(String(contact).trim())) errors.push('Contact number must be 7-15 digits (may start with +).');
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) errors.push('A valid email is required (e.g., mary@mary.com).');

  return errors;
};

const validateCardDetails = (payload = {}) => {
  const { cardNumber, expiry, cvv } = payload;
  const errors = [];

  if (!cardNumber || !/^\d{16}$/.test(String(cardNumber).trim())) errors.push('Card number must be exactly 16 digits.');
  if (!cvv || !/^\d{3,4}$/.test(String(cvv).trim())) errors.push('CVV must be 3-4 digits.');
  if (!expiry || !/^(0[1-9]|1[0-2])\/\d{2}$/.test(String(expiry).trim())) {
    errors.push('Expiry must be in MM/YY format.');
  } else {
    const [mm, yy] = expiry.split('/');
    const month = parseInt(mm, 10);
    const year = 2000 + parseInt(yy, 10);
    const now = new Date();
    const expDate = new Date(year, month);
    if (expDate <= now) errors.push('Card has expired.');
  }

  return errors;
};

const computeCheckoutState = (user, formData, loyaltyRedemption, callback) => {
  const userId = user.id;
  CartModel.getCartByUser(userId, (err, items) => {
    if (err) return callback(err);

    const { cart, cartTotal } = mapCartItems(items);

    OrderModel.getOrdersByUser(userId, (orderErr, orders) => {
      if (orderErr) return callback(orderErr);

      const discountEligible = !orders || orders.length === 0;
      const discountPercent = discountEligible ? 25 : 0;
      const discountedTotal = Number((cartTotal * (1 - discountPercent / 100)).toFixed(2));
      const firstOrderDiscount = Math.max(0, Number((cartTotal - discountedTotal).toFixed(2)));
      const loyaltyUsage = computeLoyaltyUsage(loyaltyRedemption, discountedTotal);
      const maxAfterLoyalty = Math.max(0, discountedTotal - loyaltyUsage.discountAmount);

      const orderItems = cart.map((item) => ({
        productId: item.productId,
        quantity: Number(item.quantity),
        price: item.discountedPrice,
        productName: item.productName,
        image: item.image
      }));

      const checkoutDetails = {
        fullName: (formData && formData.fullName) || user.username || '',
        address: (formData && formData.address) || user.address || '',
        contact: (formData && formData.contact) || user.contact || '',
        email: (formData && formData.email) || user.email || ''
      };

      RefundCreditModel.getLatestAvailableByUser(userId, (creditErr, credit) => {
        if (creditErr) console.error('Error loading refund credit', creditErr);
        const availableCredit = credit && Number(credit.amount) ? Number(credit.amount) : 0;
        const refundCreditAmount = Number(Math.min(maxAfterLoyalty, Math.max(0, availableCredit)).toFixed(2));
        const payableTotal = Number((Math.max(0, maxAfterLoyalty - refundCreditAmount)).toFixed(2));

        callback(null, {
          cart,
          cartTotal,
          discountedTotal,
          discountPercent,
          discountAmount: firstOrderDiscount,
          loyaltyDiscount: loyaltyUsage.discountAmount,
          loyaltyPoints: loyaltyUsage.pointsUsed,
          refundCreditAmount,
          refundCreditId: credit ? credit.id : null,
          payableTotal,
          orderItems,
          checkoutDetails
        });
      });
    });
  });
};

const decrementStockForOrder = (orderItems) => {
  if (!orderItems || !orderItems.length) return Promise.resolve();

  const tasks = orderItems.map((item) => new Promise((resolve, reject) => {
    ProductModel.decrementQuantity(item.productId, item.quantity, (decErr, result) => {
      if (decErr) {
        console.error('Error decrementing stock', decErr);
        return reject(decErr);
      }
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

const persistOrder = (orderPayload, callback) => {
  const {
    userId,
    totalAmount,
    discountPercent,
    orderItems,
    checkoutDetails,
    discountAmount,
    loyaltyDiscount,
    loyaltyPoints,
    transactionId,
    transactionRefId,
    paymentMethod,
    refundCreditAmount,
    refundCreditId
  } = orderPayload;
  const payload = {
    userId,
    totalAmount,
    discountPercent: discountPercent || 0,
    status: 'processing'
  };
  if (transactionId) {
    payload.transactionId = transactionId;
  }
  if (transactionRefId) {
    payload.transactionRefId = transactionRefId;
  }
  if (paymentMethod) {
    payload.paymentMethod = paymentMethod;
  }

  OrderModel.createOrder(payload, orderItems, (orderErr, result) => {
    if (orderErr) return callback(orderErr);
    const orderId = result.orderId;

    const finalize = (orderData) => {
      const pointsToGrant = Math.floor((Number(totalAmount) || 0) * 10);
      const pointsToDeduct = Math.max(0, Math.floor(Number(loyaltyPoints) || 0));
      const membershipTask = new Promise((resolve) => {
        if (!pointsToGrant && !pointsToDeduct) return resolve();
        MembershipModel.getByUser(userId, (mErr, membership) => {
          if (mErr) {
            console.error('Error checking membership', mErr);
            return resolve();
          }
          if (!membership) return resolve();
          const operations = [];
          if (pointsToDeduct > 0) {
            const deductionPoints = Math.min(membership.points, pointsToDeduct);
            if (deductionPoints > 0) {
              operations.push((cb) => {
                MembershipModel.addPoints(userId, -deductionPoints, (deductErr) => {
                  if (deductErr) console.error('Error deducting membership points', deductErr);
                  cb();
                });
              });
            }
          }
          if (pointsToGrant > 0) {
            operations.push((cb) => {
              MembershipModel.addPoints(userId, pointsToGrant, (addErr) => {
                if (addErr) console.error('Error adding membership points', addErr);
                cb();
              });
            });
          }
          const runOperations = () => {
            if (!operations.length) return resolve();
            const nextOp = operations.shift();
            nextOp(runOperations);
          };
          runOperations();
        });
      });

      const creditTask = new Promise((resolve) => {
        if (!refundCreditId || !refundCreditAmount || Number(refundCreditAmount) <= 0) return resolve();
        RefundCreditModel.markUsed(refundCreditId, orderId, (cErr) => {
          if (cErr) console.error('Error marking refund credit used', cErr);
          resolve();
        });
      });

      Promise.all([decrementStockForOrder(orderItems), membershipTask, creditTask])
        .catch((err) => console.error('Post-order error:', err))
        .finally(() => {
          CartModel.clearCartByUser(userId, (clearErr) => {
            if (clearErr) console.error('Error clearing cart after checkout:', clearErr);
          });
          callback(null, {
            order: orderData,
            orderId,
            checkoutDetails,
            discountAmount: discountAmount || 0,
            loyaltyDiscount: loyaltyDiscount || 0,
            loyaltyPoints: loyaltyPoints || 0,
          refundCreditAmount: refundCreditAmount || 0
        });
      });
    };

    OrderModel.getOrderById(orderId, (fetchErr, order) => {
      if (fetchErr || !order) {
        const fallbackOrder = {
          id: orderId,
          userId,
          totalAmount,
          status: 'processing',
          transactionId: transactionId || null,
          transactionRefId: transactionRefId || null,
          items: orderItems
        };
        return finalize(fallbackOrder);
      }

      const enriched = {
        ...order,
        transactionId: order.transactionId || transactionId || null,
        transactionRefId: order.transactionRefId || transactionRefId || null,
        totalAmount,
        items: order.items.map((it) => {
          const fromCart = orderItems.find((ci) => ci.productId === it.productId);
          return {
            ...it,
            productName: it.productName || (fromCart && fromCart.productName) || '',
            image: it.image || (fromCart && fromCart.image) || ''
          };
        })
      };

      finalize(enriched);
    });
  });
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

    const formData = req.flash('formData')[0] || {};
    computeCheckoutState(req.session.user, formData, req.session.loyaltyRedemption, (err, checkout) => {
      if (err) {
        console.error('Error loading checkout:', err);
        req.flash('error', 'Unable to load checkout right now.');
        return res.redirect('/shopping');
      }

      MembershipModel.getByUser(req.session.user.id, (mErr, membership) => {
        if (mErr) {
          console.error('Error loading membership for checkout', mErr);
          membership = null;
        }
        if (req.session && req.session.user) {
          req.session.user.membership = !!membership;
        }
        const availablePoints = membership ? Math.max(0, Math.floor(Number(membership.points) || 0)) : 0;
        const maxPointsForTotal = Math.max(0, Math.floor(checkout.discountedTotal * 10 + Number.EPSILON) - 1);
        const maxRedeemablePoints = Math.min(availablePoints, maxPointsForTotal);
        const redemptionPoints = req.session.loyaltyRedemption
          ? Math.max(0, Math.floor(Number(req.session.loyaltyRedemption.points) || 0))
          : 0;

        res.render('checkout', {
          cart: checkout.cart,
          cartTotal: checkout.cartTotal,
          discountedTotal: checkout.discountedTotal,
          discountEligible: checkout.discountPercent > 0,
          discountPercent: checkout.discountPercent,
          loyaltyDiscount: checkout.loyaltyDiscount,
          loyaltyPoints: checkout.loyaltyPoints,
          refundCreditAmount: checkout.refundCreditAmount,
          payableTotal: checkout.payableTotal,
          user: req.session.user,
          formData,
          membership,
          availablePoints,
          maxRedeemablePoints,
          redemptionPoints,
          paypalClientId: (process.env.PAYPAL_CLIENT_ID || '').trim(),
          stripePublishableKey: (process.env.STRIPE_PUBLISHABLE_KEY || '').trim()
        });
      });
    });
  },

  processCheckout(req, res) {
    if (!req.session?.user) {
      req.flash('error', 'Please log in to checkout.');
      return res.redirect('/login');
    }

    const contactErrors = validateContactDetails(req.body);
    const cardErrors = validateCardDetails(req.body);
    const errors = [...contactErrors, ...cardErrors];

    if (errors.length) {
      req.flash('error', errors);
      req.flash('formData', req.body);
      return res.redirect('/checkout');
    }

    computeCheckoutState(req.session.user, req.body, req.session.loyaltyRedemption, (checkoutErr, checkout) => {
      if (checkoutErr) {
        console.error('Error building checkout state:', checkoutErr);
        req.flash('error', 'Unable to complete checkout right now.');
        return res.redirect('/cart');
      }

      if (!checkout.cart || checkout.cart.length === 0) {
        req.flash('error', 'Your cart is empty.');
        return res.redirect('/cart');
      }

      const loyaltySummary = checkout.loyaltyPoints
        ? `${checkout.loyaltyPoints} points redeemed for $${checkout.loyaltyDiscount.toFixed(2)} discount`
        : '';
        const payload = {
          userId: req.session.user.id,
          totalAmount: checkout.payableTotal,
          discountPercent: checkout.discountPercent,
          orderItems: checkout.orderItems,
          checkoutDetails: {
            ...checkout.checkoutDetails,
            discountApplied: checkout.discountPercent > 0 ? '25% first order discount applied' : '',
            loyaltyApplied: loyaltySummary
          },
          paymentMethod: 'CARD',
          refundCreditAmount: checkout.refundCreditAmount,
          refundCreditId: checkout.refundCreditId,
          transactionId: buildLocalTransactionId('CARD'),
          discountAmount: checkout.discountAmount,
          loyaltyDiscount: checkout.loyaltyDiscount,
          loyaltyPoints: checkout.loyaltyPoints
        };

      persistOrder(payload, (orderErr, orderResult) => {
        if (orderErr) {
          console.error('Error creating order:', orderErr);
          req.flash('error', 'Unable to place order.');
          return res.redirect('/cart');
        }
        if (req.session) delete req.session.loyaltyRedemption;

        res.render('invoice', {
          order: orderResult.order,
          orderId: orderResult.orderId,
          checkout: payload.checkoutDetails,
          discountAmount: orderResult.discountAmount,
          loyaltyDiscount: orderResult.loyaltyDiscount,
          loyaltyPoints: orderResult.loyaltyPoints,
          refundCreditAmount: orderResult.refundCreditAmount,
          user: req.session.user
        });
      });
    });
  },

  async createPaypalOrder(req, res) {
    if (!req.session?.user) {
      return res.status(401).json({ error: 'Please log in to checkout.' });
    }

    const contactErrors = validateContactDetails(req.body);
    if (contactErrors.length) {
      return res.status(400).json({ error: contactErrors[0], errors: contactErrors });
    }

    try {
      const checkout = await new Promise((resolve, reject) => {
        computeCheckoutState(req.session.user, req.body, req.session.loyaltyRedemption, (err, data) => (err ? reject(err) : resolve(data)));
      });

      if (!checkout.cart || checkout.cart.length === 0) {
        return res.status(400).json({ error: 'Your cart is empty.' });
      }

      const paypalOrder = await PaypalService.createOrder(checkout.payableTotal.toFixed(2));
      if (!paypalOrder || !paypalOrder.id) {
        return res.status(500).json({ error: 'Unable to create PayPal order.' });
      }

      req.session.paypalCheckout = {
        orderItems: checkout.orderItems,
        totalAmount: checkout.payableTotal,
        discountPercent: checkout.discountPercent,
        discountAmount: checkout.discountAmount,
        loyaltyDiscount: checkout.loyaltyDiscount,
        loyaltyPoints: checkout.loyaltyPoints,
        paymentMethod: 'PAYPAL',
        refundCreditAmount: checkout.refundCreditAmount,
        refundCreditId: checkout.refundCreditId,
        checkoutDetails: {
          ...checkout.checkoutDetails,
          discountApplied: checkout.discountPercent > 0 ? '25% first order discount applied' : '',
          loyaltyApplied: checkout.loyaltyPoints ? `${checkout.loyaltyPoints} points redeemed for $${checkout.loyaltyDiscount.toFixed(2)} discount` : ''
        },
        paypalOrderId: paypalOrder.id,
        transactionId: paypalOrder.id,
        createdAt: Date.now()
      };

      return res.json({ orderID: paypalOrder.id });
    } catch (err) {
      console.error('PayPal create order error:', err);
      return res.status(500).json({ error: 'Unable to start PayPal checkout. Please try again.' });
    }
  },

  async capturePaypalOrder(req, res) {
    if (!req.session?.user) {
      return res.status(401).json({ error: 'Please log in to checkout.' });
    }

    const { orderID } = req.body || {};
    const pending = req.session.paypalCheckout;

    if (!orderID) return res.status(400).json({ error: 'Missing PayPal order ID.' });
    if (!pending) return res.status(400).json({ error: 'No pending PayPal checkout found.' });
    if (pending.paypalOrderId && pending.paypalOrderId !== orderID) {
      return res.status(400).json({ error: 'PayPal order does not match the current session.' });
    }

    const ttlMs = 20 * 60 * 1000; // 20 minutes
    if (pending.createdAt && Date.now() - pending.createdAt > ttlMs) {
      delete req.session.paypalCheckout;
      return res.status(400).json({ error: 'PayPal session expired. Please try again.' });
    }

    try {
      const capture = await PaypalService.captureOrder(orderID);
      const captureStatus = capture?.status || capture?.purchase_units?.[0]?.payments?.captures?.[0]?.status;

      if (captureStatus && captureStatus !== 'COMPLETED') {
        return res.status(400).json({ error: `Payment not completed (status: ${captureStatus}).` });
      }

      const captureId = capture?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
      const payload = {
        userId: req.session.user.id,
        totalAmount: pending.totalAmount,
        discountPercent: pending.discountPercent,
        orderItems: pending.orderItems,
        checkoutDetails: pending.checkoutDetails,
        transactionId: pending.transactionId || pending.paypalOrderId,
        transactionRefId: captureId || null,
        paymentMethod: pending.paymentMethod || 'PAYPAL',
        discountAmount: pending.discountAmount,
        loyaltyDiscount: pending.loyaltyDiscount,
        loyaltyPoints: pending.loyaltyPoints,
        refundCreditAmount: pending.refundCreditAmount,
        refundCreditId: pending.refundCreditId
      };

      persistOrder(payload, (orderErr, orderResult) => {
        delete req.session.paypalCheckout;
        if (orderErr) {
          console.error('Error creating order after PayPal capture:', orderErr);
          return res.status(500).json({ error: 'Payment captured but order creation failed. Please contact support.' });
        }
        if (req.session) delete req.session.loyaltyRedemption;

        return res.json({
          orderId: orderResult.orderId,
          redirectUrl: `/invoice/${orderResult.orderId}`
        });
      });
    } catch (err) {
      console.error('PayPal capture error:', err);
      return res.status(500).json({ error: 'Unable to complete PayPal payment. Please try again.' });
    }
  },

  async createStripePaymentIntent(req, res) {
    if (!req.session?.user) {
      return res.status(401).json({ error: 'Please log in to checkout.' });
    }

    const contactErrors = validateContactDetails(req.body);
    if (contactErrors.length) {
      return res.status(400).json({ error: contactErrors[0], errors: contactErrors });
    }

    try {
      const checkout = await new Promise((resolve, reject) => {
        computeCheckoutState(req.session.user, req.body, req.session.loyaltyRedemption, (err, data) => (err ? reject(err) : resolve(data)));
      });

      if (!checkout.cart || checkout.cart.length === 0) {
        return res.status(400).json({ error: 'Your cart is empty.' });
      }

      const intent = await StripeService.createPaymentIntent(checkout.payableTotal, 'sgd', {
        userId: String(req.session.user.id || ''),
        cartTotal: checkout.cartTotal.toFixed(2)
      });

      if (!intent || !intent.client_secret) {
        return res.status(500).json({ error: 'Unable to start Stripe payment.' });
      }

      req.session.stripeCheckout = {
        orderItems: checkout.orderItems,
        totalAmount: checkout.payableTotal,
        discountPercent: checkout.discountPercent,
        discountAmount: checkout.discountAmount,
        loyaltyDiscount: checkout.loyaltyDiscount,
        loyaltyPoints: checkout.loyaltyPoints,
        paymentMethod: 'STRIPE',
        refundCreditAmount: checkout.refundCreditAmount,
        refundCreditId: checkout.refundCreditId,
        checkoutDetails: {
          ...checkout.checkoutDetails,
          discountApplied: checkout.discountPercent > 0 ? '25% first order discount applied' : '',
          loyaltyApplied: checkout.loyaltyPoints ? `${checkout.loyaltyPoints} points redeemed for $${checkout.loyaltyDiscount.toFixed(2)} discount` : ''
        },
        stripePaymentIntentId: intent.id,
        transactionId: intent.id,
        createdAt: Date.now()
      };

      return res.json({ clientSecret: intent.client_secret });
    } catch (err) {
      console.error('Stripe create intent error:', err);
      return res.status(500).json({ error: 'Unable to start Stripe payment. Please try again.' });
    }
  },

  async confirmStripePayment(req, res) {
    if (!req.session?.user) {
      return res.status(401).json({ error: 'Please log in to checkout.' });
    }

    const { paymentIntentId } = req.body || {};
    const pending = req.session.stripeCheckout;

    if (!paymentIntentId) return res.status(400).json({ error: 'Missing Stripe payment intent.' });
    if (!pending) return res.status(400).json({ error: 'No pending Stripe checkout found.' });
    if (pending.stripePaymentIntentId && pending.stripePaymentIntentId !== paymentIntentId) {
      return res.status(400).json({ error: 'Stripe payment intent does not match the current session.' });
    }

    const ttlMs = 20 * 60 * 1000; // 20 minutes
    if (pending.createdAt && Date.now() - pending.createdAt > ttlMs) {
      delete req.session.stripeCheckout;
      return res.status(400).json({ error: 'Stripe session expired. Please try again.' });
    }

    try {
      const details = await StripeService.getPaymentIntentDetails(paymentIntentId);
      if (details.status !== 'succeeded') {
        return res.status(400).json({ error: `Payment not completed (status: ${details.status}).` });
      }

      const payload = {
        userId: req.session.user.id,
        totalAmount: pending.totalAmount,
        discountPercent: pending.discountPercent,
        orderItems: pending.orderItems,
        checkoutDetails: pending.checkoutDetails,
        transactionId: pending.transactionId || pending.stripePaymentIntentId,
        transactionRefId: details.chargeId || null,
        paymentMethod: pending.paymentMethod || 'STRIPE',
        discountAmount: pending.discountAmount,
        loyaltyDiscount: pending.loyaltyDiscount,
        loyaltyPoints: pending.loyaltyPoints,
        refundCreditAmount: pending.refundCreditAmount,
        refundCreditId: pending.refundCreditId
      };

      persistOrder(payload, (orderErr, orderResult) => {
        delete req.session.stripeCheckout;
        if (orderErr) {
          console.error('Error creating order after Stripe payment:', orderErr);
          return res.status(500).json({ error: 'Payment captured but order creation failed. Please contact support.' });
        }
        if (req.session) delete req.session.loyaltyRedemption;

        return res.json({
          orderId: orderResult.orderId,
          redirectUrl: `/invoice/${orderResult.orderId}`
        });
      });
    } catch (err) {
      console.error('Stripe confirm payment error:', err);
      return res.status(500).json({ error: 'Unable to complete Stripe payment. Please try again.' });
    }
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
  },

  redeemLoyalty(req, res) {
    if (!req.session?.user) {
      req.flash('error', 'Please log in to redeem points.');
      return res.redirect('/login');
    }

    const action = (req.body && req.body.action) ? req.body.action : 'apply';
    if (action === 'clear') {
      delete req.session.loyaltyRedemption;
      req.flash('success', 'Loyalty redemption cleared.');
      return res.redirect('/checkout');
    }

    const rawPoints = Number(req.body && req.body.points);
    const requestedPoints = Number.isFinite(rawPoints) ? Math.floor(rawPoints) : 0;
    if (requestedPoints <= 0) {
      req.flash('error', 'Enter a valid number of points to redeem.');
      return res.redirect('/checkout');
    }

    const userId = req.session.user.id;
    MembershipModel.getByUser(userId, (mErr, membership) => {
      if (mErr) {
        console.error('Error loading membership for redemption', mErr);
        req.flash('error', 'Unable to redeem loyalty points right now.');
        return res.redirect('/checkout');
      }
      if (!membership) {
        req.flash('error', 'You need to join membership to redeem loyalty points.');
        return res.redirect('/checkout');
      }

      const availablePoints = Math.max(0, Math.floor(Number(membership.points) || 0));
      if (availablePoints <= 0) {
        req.flash('error', 'No loyalty points available to redeem.');
        return res.redirect('/checkout');
      }
      if (requestedPoints > availablePoints) {
        req.flash('error', `You only have ${availablePoints} point${availablePoints === 1 ? '' : 's'} available.`);
        return res.redirect('/checkout');
      }

      computeCheckoutState(req.session.user, {}, null, (checkoutErr, checkout) => {
        if (checkoutErr) {
          console.error('Error loading checkout for redemption', checkoutErr);
          req.flash('error', 'Unable to redeem loyalty points right now.');
          return res.redirect('/checkout');
        }
        if (!checkout.cart || checkout.cart.length === 0) {
          req.flash('error', 'Your cart is empty.');
          return res.redirect('/cart');
        }

        const maxPointsForTotal = Math.max(0, Math.floor(checkout.discountedTotal * 10 + Number.EPSILON) - 1);
        if (maxPointsForTotal <= 0) {
          req.flash('error', 'Unable to apply loyalty points to this total.');
          return res.redirect('/checkout');
        }
        if (requestedPoints > maxPointsForTotal) {
          req.flash('error', `You can redeem up to ${maxPointsForTotal} point${maxPointsForTotal === 1 ? '' : 's'} for this payment amount (must be less than the total).`);
          return res.redirect('/checkout');
        }

        req.session.loyaltyRedemption = {
          points: requestedPoints,
          amount: Number((requestedPoints / 10).toFixed(2))
        };
        req.flash('success', `Applied loyalty discount for $${(requestedPoints / 10).toFixed(2)} (using ${requestedPoints} points).`);
        return res.redirect('/checkout');
      });
    });
  }
};

module.exports = CartController;
