const OrderModel = require('../models/order');

const OrderController = {
  listOrders(req, res) {
    OrderModel.getAllOrders((err, orders) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      res.json(orders);
    });
  },

  getOrder(req, res) {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid order id' });

    OrderModel.getOrderById(id, (err, order) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      if (!order) return res.status(404).json({ error: 'Order not found' });
      res.json(order);
    });
  },

  createOrder(req, res) {
    const { userId, totalAmount, status, items } = req.body;
    if (!userId || totalAmount == null || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Missing required fields: userId, totalAmount, items[]' });
    }

    const orderData = { userId, totalAmount, status };
    OrderModel.createOrder(orderData, items, (err, result) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      res.status(201).json({ id: result.orderId, ...orderData, items });
    });
  },

  updateOrder(req, res) {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid order id' });

    const { userId, totalAmount, status, items } = req.body;
    const orderData = { userId, totalAmount, status };

    OrderModel.updateOrder(id, orderData, items, (err, result) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      if (!result) return res.status(404).json({ error: 'Order not found' });
      res.json({ message: 'Order updated', id });
    });
  },

  deleteOrder(req, res) {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid order id' });

    OrderModel.deleteOrder(id, (err, result) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      if (!result) return res.status(404).json({ error: 'Order not found' });
      res.json({ message: 'Order deleted' });
    });
  }
};

module.exports = OrderController;
