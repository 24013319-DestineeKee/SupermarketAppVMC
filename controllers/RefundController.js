const path = require('path');
const fs = require('fs');
const OrderModel = require('../models/order');
const RefundModel = require('../models/refund');
const MembershipModel = require('../models/membership');

const ensureUploadsDir = () => {
  const dir = path.join(__dirname, '..', 'public', 'reports');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
};

const validateReport = (body) => {
  const errors = [];
  if (!body.reason || !body.reason.trim()) errors.push('Reason is required.');
  if (!body.description || !body.description.trim()) errors.push('Description is required.');
  if (body.supportType && !['full_refund', 'partial_refund'].includes(body.supportType)) {
    errors.push('Invalid support type.');
  }
  return errors;
};

const RefundController = {
  ensureRequiredFields(req, res, next) {
    const errors = validateReport(req.body || []);
    if (!req.body.supportType) errors.push('Refund type is required.');
    if (!req.file) errors.push('Evidence image is required.');
    if (errors.length) {
      req.flash('error', errors);
      return res.redirect(`/orders/${req.params.id}/report`);
    }
    return next();
  },

  reportForm(req, res) {
    const orderId = parseInt(req.params.id, 10);
    if (Number.isNaN(orderId)) {
      req.flash('error', 'Invalid order.');
      return res.redirect('/my-orders');
    }
    OrderModel.getOrderById(orderId, (err, order) => {
      if (err || !order) {
        req.flash('error', 'Order not found.');
        return res.redirect('/my-orders');
      }
      if (req.session.user.role !== 'admin' && order.userId !== req.session.user.id) {
        req.flash('error', 'Access denied.');
        return res.redirect('/my-orders');
      }
      RefundModel.getReportByOrder(orderId, (rErr, report) => {
        res.render('reportIssue', {
          order,
          report,
          user: req.session.user,
          messages: { error: req.flash('error'), success: req.flash('success') }
        });
      });
    });
  },

  submitReport(req, res) {
    const orderId = parseInt(req.params.id, 10);
    if (Number.isNaN(orderId)) {
      req.flash('error', 'Invalid order.');
      return res.redirect('/my-orders');
    }

    const errors = validateReport(req.body || {});
    if (errors.length) {
      req.flash('error', errors);
      return res.redirect(`/orders/${orderId}/report`);
    }

    OrderModel.getOrderById(orderId, (err, order) => {
      if (err || !order) {
        req.flash('error', 'Order not found.');
        return res.redirect('/my-orders');
      }
      if (req.session.user.role !== 'admin' && order.userId !== req.session.user.id) {
        req.flash('error', 'Access denied.');
        return res.redirect('/my-orders');
      }

      const image = req.file ? req.file.filename : null;
      const payload = {
        orderId,
        userId: order.userId,
        reason: req.body.reason,
        description: req.body.description,
        image,
        supportType: req.body.supportType || 'full_refund'
      };
      RefundModel.createReport(payload, (createErr) => {
        if (createErr) {
          console.error('Error creating report', createErr);
          req.flash('error', 'Unable to submit report.');
          return res.redirect('/my-orders');
        }
        req.flash('success', 'Issue reported. We will review it soon.');
        return res.redirect('/my-orders');
      });
    });
  },

  listReports(req, res) {
    RefundModel.getAllReports((err, reports) => {
      if (err) {
        console.error('Error loading reports', err);
        req.flash('error', 'Unable to load refund reports.');
        return res.redirect('/orders');
      }
      res.render('refundDashboard', {
        reports: reports || [],
        user: req.session.user,
        messages: { error: req.flash('error'), success: req.flash('success') }
      });
    });
  },

  resolveReport(req, res) {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      req.flash('error', 'Invalid report id.');
      return res.redirect('/refunds');
    }

    const { status, refundAmount, resolutionNote } = req.body;
    const allowed = ['pending', 'approved_full', 'approved_partial', 'rejected'];
    if (!allowed.includes(status)) {
      req.flash('error', 'Invalid status.');
      return res.redirect('/refunds');
    }

    const amount = refundAmount != null && refundAmount !== '' ? Number(refundAmount) : 0;
    if ((status === 'approved_partial' || status === 'approved_full') && (!Number.isFinite(amount) || amount < 0)) {
      req.flash('error', 'Refund amount must be a valid number.');
      return res.redirect('/refunds');
    }

    RefundModel.getReportById(id, (findErr, report) => {
      if (findErr || !report) {
        req.flash('error', 'Report not found.');
        return res.redirect('/refunds');
      }

      const targetAmount = status === 'approved_full' ? (report.orderTotal || amount || 0) : amount;
      const updates = {
        status,
        refundAmount: targetAmount,
        resolutionNote: resolutionNote || ''
      };

      RefundModel.updateReport(id, updates, (updateErr) => {
        if (updateErr) {
          console.error('Error updating report', updateErr);
          req.flash('error', 'Unable to update report.');
          return res.redirect('/refunds');
        }
        const orderStatus = (() => {
          if (status === 'approved_full') return 'refund_full';
          if (status === 'approved_partial') return 'refund_partial';
          if (status === 'rejected') return 'refund_rejected';
          return null;
        })();
        if (!orderStatus) {
          req.flash('success', 'Report updated.');
          return res.redirect('/refunds');
        }

        OrderModel.updateStatus(report.orderId, orderStatus, (sErr) => {
          if (sErr) console.error('Error updating order status for refund', sErr);
          const percent = status === 'approved_full' ? 0.25 : (status === 'approved_partial' ? 0.10 : 0);
          const basePoints = Math.floor((Number(report.orderTotal || 0) * 10) || 0);
          const bonus = Math.floor(basePoints * percent);
          if (bonus <= 0) {
            req.flash('success', 'Report updated.');
            return res.redirect('/refunds');
          }
          // Only award bonus if user is a member
          MembershipModel.getByUser(report.userId, (mErr, membership) => {
            if (mErr) {
              console.error('Error checking membership for refund bonus', mErr);
              req.flash('success', 'Report updated.');
              return res.redirect('/refunds');
            }
            if (!membership) {
              req.flash('success', 'Report updated.');
              return res.redirect('/refunds');
            }
            MembershipModel.addPoints(report.userId, bonus, (pErr) => {
              if (pErr) console.error('Error adding membership points after refund', pErr);
              req.flash('success', 'Report updated.');
              return res.redirect('/refunds');
            });
          });
        });
      });
    });
  },

  ensureUploadsDir
};

module.exports = RefundController;
