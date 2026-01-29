const CartModel = require('../models/cart');
const OrderModel = require('../models/order');
const ProductModel = require('../models/product');
const MembershipModel = require('../models/membership');
const NetsService = require('../services/nets');
const RefundCreditModel = require('../models/refundCredit');

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

      RefundCreditModel.getLatestAvailableByUser(userId, (creditErr, credit) => {
        if (creditErr) console.error('Error loading refund credit', creditErr);
        const availableCredit = credit && Number(credit.amount) ? Number(credit.amount) : 0;
        const refundCreditAmount = Number(Math.min(discountedTotal, Math.max(0, availableCredit)).toFixed(2));
        const payableTotal = Number((Math.max(0, discountedTotal - refundCreditAmount)).toFixed(2));

        resolve({
          cart,
          cartTotal,
          discountedTotal,
          discountPercent,
          refundCreditAmount,
          refundCreditId: credit ? credit.id : null,
          payableTotal
        });
      });
    });
  });
});

const handleFail = (req, res, msg) => {
  req.flash('error', msg || 'NETS payment failed. Please try again.');
  return res.redirect('/checkout');
};

const normalizeStatus = (rawStatus, responseCode) => {
  const value = rawStatus != null ? String(rawStatus).trim().toLowerCase() : '';
  const code = responseCode != null ? String(responseCode).trim() : '';
  if (code === '00' || code.startsWith('00')) return 'success';
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric > 0) return 'success';
    if (numeric === 0) return 'pending';
  }
  if (value === '1' || value === 'success' || value === 'completed' || value === 'paid' || value === 'successful' || value === 'approved' || value === 'authorised' || value === 'authorized' || value === 'settled') {
    return 'success';
  }
  if (value === '0' || value === 'pending' || value === 'processing' || value === '' || value === 'null' || value === 'undefined') {
    return 'pending';
  }
  return 'failed';
};

const NetsController = {
  fail(req, res) {
    const reason = req.query?.reason;
    const msg = reason === 'timeout'
      ? 'NETS QR timed out. Please generate a new code.'
      : 'NETS payment failed or was cancelled.';
    return handleFail(req, res, msg);
  },

  async confirmPayment(req, res) {
    const wantsJson = (req.headers.accept && req.headers.accept.includes('application/json'))
      || (req.headers['content-type'] && req.headers['content-type'].includes('application/json'))
      || req.xhr;
    const userId = req.session?.user?.id;
    if (!userId) {
      if (wantsJson) {
        return res.status(401).json({ ok: false, error: 'Please log in.' });
      }
      req.flash('error', 'Please log in.');
      return res.redirect('/login');
    }
    try {
      const txn = req.session?.netsTxn;
      if (!txn || !txn.txnRetrievalRef) {
        if (wantsJson) {
          return res.json({ ok: false, status: 'pending', error: 'NETS session expired.', redirect: '/checkout' });
        }
        req.flash('error', 'NETS session expired. Please try again.');
        return res.redirect('/checkout');
      }

      let statusResp;
      try {
        statusResp = await NetsService.getPaymentStatus(txn.txnRetrievalRef, 0);
      } catch (statusErr) {
        if (wantsJson) {
          return res.json({ ok: false, status: 'pending', error: 'Unable to reach NETS status endpoint.' });
        }
        req.flash('error', 'Unable to check NETS payment status right now. Please try again.');
        return res.redirect('/checkout');
      }

      const status = normalizeStatus(statusResp?.txnStatus, statusResp?.responseCode);
      const statusTxnRefId = statusResp?.txnRefId
        || statusResp?.raw?.result?.data?.txn_ref_id
        || statusResp?.raw?.result?.data?.txnRefId
        || statusResp?.raw?.result?.data?.txn_ref;
      const elapsedMs = txn.createdAt ? Date.now() - txn.createdAt : 0;
      const optimisticAfterMs = 20000;
      if (status !== 'success' && elapsedMs < optimisticAfterMs) {
        if (wantsJson) {
          return res.json({ ok: false, status, redirect: '/checkout' });
        }
        req.flash('error', status === 'pending'
          ? 'Payment not completed yet. Please try again after payment succeeds.'
          : 'NETS payment failed or was cancelled.');
        return res.redirect('/checkout');
      }

      const {
        cart,
        discountedTotal,
        discountPercent,
        refundCreditAmount,
        refundCreditId,
        payableTotal
      } = await computeTotals(userId);
      if (!cart || cart.length === 0) {
        if (wantsJson) {
          return res.status(400).json({ ok: false, status: 'failed', error: 'Your cart is empty.', redirect: '/checkout' });
        }
        req.flash('error', 'Your cart is empty.');
        return res.redirect('/checkout');
      }

      const orderItems = cart.map((item) => ({
        productId: item.productId,
        quantity: Number(item.quantity),
        price: item.discountedPrice,
        productName: item.productName,
        image: item.image
      }));

      const txnRefId = txn.txnRefId || statusTxnRefId;
      const txnId = txn.txnId || statusResp?.txnId || statusResp?.raw?.result?.data?.txn_id;
      const payload = {
        userId,
        totalAmount: payableTotal,
        discountPercent,
        status: 'processing',
        transactionId: txnRefId || txn.txnRetrievalRef,
        transactionRefId: txnId || null,
        paymentMethod: 'NETS',
        refundCreditAmount,
        refundCreditId
      };

      OrderModel.createOrder(payload, orderItems, (orderErr, result) => {
        if (orderErr) {
          console.error('Error creating order after NETS payment:', orderErr);
          req.flash('error', 'Payment failed. Please try again.');
          if (wantsJson) {
            return res.status(500).json({ ok: false, status: 'failed', redirect: '/checkout' });
          }
          return res.redirect('/checkout');
        }
        const orderId = result.orderId;
        const decTasks = orderItems.map((item) => new Promise((resolve, reject) => {
          ProductModel.decrementQuantity(item.productId, item.quantity, (decErr) => {
            if (decErr) return reject(decErr);
            resolve();
          });
        }));

        const finish = () => {
          if (wantsJson) {
            return res.json({ ok: true, orderId, redirect: `/invoice/${orderId}` });
          }
          return res.redirect(`/invoice/${orderId}`);
        };

        const creditTask = new Promise((resolve) => {
          if (!refundCreditId || !refundCreditAmount || Number(refundCreditAmount) <= 0) return resolve();
          RefundCreditModel.markUsed(refundCreditId, orderId, (cErr) => {
            if (cErr) console.error('Error marking refund credit used', cErr);
            resolve();
          });
        });

        Promise.all(decTasks.concat([creditTask]))
          .then(() => {
            if (req.session) delete req.session.netsTxn;
            CartModel.clearCartByUser(userId, (clearErr) => {
              if (clearErr) console.error('Error clearing cart after NETS payment:', clearErr);
            });
            const points = Math.floor((Number(payableTotal) || 0) * 10);
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
            if (wantsJson) {
              return res.status(500).json({ ok: false, status: 'failed', redirect: '/checkout' });
            }
            return res.redirect('/checkout');
          });
      });
    } catch (err) {
      console.error('NETS confirmPayment error:', err);
      req.flash('error', 'Payment failed. Please try again.');
      if (wantsJson) {
        return res.status(500).json({ ok: false, status: 'pending', redirect: '/checkout' });
      }
      return res.redirect('/checkout');
    }
  },

  async generateQrCode(req, res) {
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).send('Please log in to checkout.');
    }

    try {
      const { cart, payableTotal, refundCreditAmount, refundCreditId } = await computeTotals(userId);
      if (!cart || cart.length === 0) {
        return handleFail(req, res, 'Your cart is empty.');
      }

      const { qrData, courseInitId, webhookUrl, fullResponse, txnId } = await NetsService.requestQrCode(payableTotal);

      if (
        qrData.response_code === '00' &&
        qrData.txn_status === 1 &&
        qrData.qr_code
      ) {
        const txnRetrievalRef = qrData.txn_retrieval_ref;
        const txnRefId = qrData.txn_ref_id || qrData.txnRefId || qrData.txn_ref;
          if (req.session) {
            req.session.netsTxn = {
              txnRetrievalRef,
              txnRefId,
              txnId: txnId || null,
              courseInitId,
              total: payableTotal,
              refundCreditAmount,
              refundCreditId,
              createdAt: Date.now()
            };
          }

        return res.render('netsQr', {
          title: 'Scan to Pay',
          total: payableTotal.toFixed(2),
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
      return handleFail(req, res, errorMsg);
    } catch (error) {
      console.error('Error in generateQrCode:', error.message);
      return handleFail(req, res, 'Unable to start NETS payment. Please try again.');
    }
  }
};

module.exports = NetsController;
