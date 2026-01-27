const CartModel = require('../models/cart');
const OrderModel = require('../models/order');
const ProductModel = require('../models/product');
const MembershipModel = require('../models/membership');
const NetsService = require('../services/nets');

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

const computeTotals = (userId) => new Promise((resolve, reject) => {
  CartModel.getCartByUser(userId, (err, items) => {
    if (err) return reject(err);

    const { cart, cartTotal } = mapCartItems(items);

    OrderModel.getOrdersByUser(userId, (orderErr, orders) => {
      if (orderErr) return reject(orderErr);

      const discountEligible = !orders || orders.length === 0;
      const discountPercent = discountEligible ? 25 : 0;
      const discountedTotal = discountPercent > 0 ? Number((cartTotal * 0.75).toFixed(2)) : cartTotal;

      resolve({
        cart,
        cartTotal,
        discountedTotal,
        discountPercent
      });
    });
  });
});

const NetsController = {
  handleFail(req, res, msg) {
    req.flash('error', msg || 'NETS payment failed. Please try again.');
    return res.redirect('/checkout');
  },

  fail(req, res) {
    const reason = req.query?.reason;
    const msg = reason === 'timeout'
      ? 'NETS QR timed out. Please generate a new code.'
      : 'NETS payment failed or was cancelled.';
    return this.handleFail(req, res, msg);
  },

  async confirmPayment(req, res) {
    const userId = req.session?.user?.id;
    if (!userId) {
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(401).json({ ok: false, error: 'Please log in.' });
      }
      req.flash('error', 'Please log in.');
      return res.redirect('/login');
    }
    try {
      const { cart, discountedTotal, discountPercent } = await computeTotals(userId);
      if (!cart || cart.length === 0) {
        if (req.headers.accept && req.headers.accept.includes('application/json')) {
          return res.status(400).json({ ok: false, error: 'Your cart is empty.' });
        }
        req.flash('error', 'Your cart is empty.');
        return res.redirect('/cart');
      }

      const orderItems = cart.map((item) => ({
        productId: item.productId,
        quantity: Number(item.quantity),
        price: item.discountedPrice,
        productName: item.productName,
        image: item.image
      }));

      const payload = {
        userId,
        totalAmount: discountedTotal,
        discountPercent,
        status: 'processing'
      };

      OrderModel.createOrder(payload, orderItems, (orderErr, result) => {
        if (orderErr) {
          console.error('Error creating order after NETS payment:', orderErr);
          req.flash('error', 'Payment failed. Please try again.');
          if (req.headers.accept && req.headers.accept.includes('application/json')) {
            return res.status(500).json({ ok: false, redirect: '/nets/qr' });
          }
          return res.redirect('/nets/qr');
        }
        const orderId = result.orderId;
        const decTasks = orderItems.map((item) => new Promise((resolve, reject) => {
          ProductModel.decrementQuantity(item.productId, item.quantity, (decErr) => {
            if (decErr) return reject(decErr);
            resolve();
          });
        }));

        const finish = () => {
          if (req.headers.accept && req.headers.accept.includes('application/json')) {
            return res.json({ ok: true, orderId, redirect: '/shopping' });
          }
          return res.redirect('/shopping');
        };

        Promise.all(decTasks)
          .then(() => {
            CartModel.clearCartByUser(userId, (clearErr) => {
              if (clearErr) console.error('Error clearing cart after NETS payment:', clearErr);
            });
            const points = Math.floor((Number(discountedTotal) || 0) * 10);
            if (points <= 0) return finish();
            MembershipModel.getByUser(userId, (mErr, membership) => {
              if (mErr || !membership) return finish();
              MembershipModel.addPoints(userId, points, (pErr) => {
                if (pErr) console.error('Membership points error after NETS payment:', pErr);
                return finish();
              });
            });
          })
          .catch((err) => {
            console.error('Stock decrement error after NETS payment:', err);
            req.flash('error', 'Payment failed. Please try again.');
            if (req.headers.accept && req.headers.accept.includes('application/json')) {
              return res.status(500).json({ ok: false, redirect: '/nets/qr' });
            }
            return res.redirect('/nets/qr');
          });
      });
    } catch (err) {
      console.error('NETS confirmPayment error:', err);
      req.flash('error', 'Payment failed. Please try again.');
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(500).json({ ok: false, redirect: '/nets/qr' });
      }
      return res.redirect('/nets/qr');
    }
  },

  async generateQrCode(req, res) {
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).send('Please log in to checkout.');
    }

    try {
      const { cart, discountedTotal } = await computeTotals(userId);
      if (!cart || cart.length === 0) {
        return this.handleFail(req, res, 'Your cart is empty.');
      }

      const { qrData, courseInitId, webhookUrl, fullResponse } = await NetsService.requestQrCode(discountedTotal);

      if (
        qrData.response_code === '00' &&
        qrData.txn_status === 1 &&
        qrData.qr_code
      ) {
        const txnRetrievalRef = qrData.txn_retrieval_ref;

        return res.render('netsQr', {
          title: 'Scan to Pay',
          total: discountedTotal.toFixed(2),
          qrCodeUrl: `data:image/png;base64,${qrData.qr_code}`,
          user: req.session.user,
          txnRetrievalRef,
          courseInitId,
          networkCode: qrData.network_status,
          timer: 300,
          webhookUrl,
          fullNetsResponse: fullResponse,
          apiKey: process.env.API_KEY,
          projectId: process.env.PROJECT_ID
        });
      }

      const errorMsg = qrData.error_message || 'An error occurred while generating the QR code.';
      return this.handleFail(req, res, errorMsg);
    } catch (error) {
      console.error('Error in generateQrCode:', error.message);
      return this.handleFail(req, res, 'Unable to start NETS payment. Please try again.');
    }
  }
};

module.exports = NetsController;
