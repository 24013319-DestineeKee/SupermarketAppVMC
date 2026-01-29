const db = require('../db');

const OrderModel = {
  getAllOrders(callback) {
    const orderSql = 'SELECT id, userId, totalAmount, discountPercent, status, transactionId, transactionRefId, paymentMethod FROM orders';
    db.query(orderSql, (orderErr, orders) => {
      if (orderErr) return callback(orderErr);
      if (!orders.length) return callback(null, []);

      const orderIds = orders.map((o) => o.id);
      const itemsSql = `
        SELECT oi.id, oi.orderId, oi.productId, oi.quantity, oi.price,
               p.productName, p.image
        FROM order_items oi
        LEFT JOIN products p ON p.id = oi.productId
        WHERE oi.orderId IN (?)
      `;
      db.query(itemsSql, [orderIds], (itemsErr, items) => {
        if (itemsErr) return callback(itemsErr);

        const itemsByOrder = {};
        items.forEach((item) => {
          if (!itemsByOrder[item.orderId]) itemsByOrder[item.orderId] = [];
          itemsByOrder[item.orderId].push(item);
        });

        const hydrated = orders.map((order) => ({
          ...order,
          items: itemsByOrder[order.id] || []
        }));
        callback(null, hydrated);
      });
    });
  },

  updateStatus(id, status, callback) {
    const sql = 'UPDATE orders SET status = ? WHERE id = ?';
    db.query(sql, [status, id], (err, result) => callback(err, result));
  },

  getOrderById(id, callback) {
    const orderSql = 'SELECT id, userId, totalAmount, discountPercent, status, transactionId, transactionRefId, paymentMethod FROM orders WHERE id = ?';
    db.query(orderSql, [id], (orderErr, orderResults) => {
      if (orderErr) return callback(orderErr);
      const order = orderResults[0];
      if (!order) return callback(null, null);

      const itemsSql = `
        SELECT oi.id, oi.orderId, oi.productId, oi.quantity, oi.price,
               p.productName, p.image
        FROM order_items oi
        LEFT JOIN products p ON p.id = oi.productId
        WHERE oi.orderId = ?
      `;
      db.query(itemsSql, [id], (itemsErr, items) => {
        if (itemsErr) return callback(itemsErr);
        callback(null, { ...order, items: items || [] });
      });
    });
  },

  getOrdersByUser(userId, callback) {
    const orderSql = 'SELECT id, userId, totalAmount, discountPercent, status, transactionId, transactionRefId, paymentMethod FROM orders WHERE userId = ?';
    db.query(orderSql, [userId], (orderErr, orders) => {
      if (orderErr) return callback(orderErr);
      if (!orders.length) return callback(null, []);

      const orderIds = orders.map((o) => o.id);
      const itemsSql = `
        SELECT oi.id, oi.orderId, oi.productId, oi.quantity, oi.price,
               p.productName, p.image
        FROM order_items oi
        LEFT JOIN products p ON p.id = oi.productId
        WHERE oi.orderId IN (?)
      `;
      db.query(itemsSql, [orderIds], (itemsErr, items) => {
        if (itemsErr) return callback(itemsErr);

        const itemsByOrder = {};
        items.forEach((item) => {
          if (!itemsByOrder[item.orderId]) itemsByOrder[item.orderId] = [];
          itemsByOrder[item.orderId].push(item);
        });

        const hydrated = orders.map((order) => ({
          ...order,
          items: itemsByOrder[order.id] || []
        }));
        callback(null, hydrated);
      });
    });
  },

  createOrder(orderData, items, callback) {
    const safeItems = Array.isArray(items) ? items : [];

    db.beginTransaction((txErr) => {
      if (txErr) return callback(txErr);

      const hasTransactionId = orderData.transactionId != null && orderData.transactionId !== '';
      const hasTransactionRefId = orderData.transactionRefId != null && orderData.transactionRefId !== '';
      const hasPaymentMethod = orderData.paymentMethod != null && orderData.paymentMethod !== '';
      const columns = ['userId', 'totalAmount', 'discountPercent', 'status'];
      const values = [
        orderData.userId,
        orderData.totalAmount,
        orderData.discountPercent || 0,
        orderData.status || 'pending'
      ];
      if (hasTransactionId) {
        columns.push('transactionId');
        values.push(orderData.transactionId);
      }
      if (hasTransactionRefId) {
        columns.push('transactionRefId');
        values.push(orderData.transactionRefId);
      }
      if (hasPaymentMethod) {
        columns.push('paymentMethod');
        values.push(orderData.paymentMethod);
      }
      const placeholders = columns.map(() => '?').join(', ');
      const insertOrderSql = `INSERT INTO orders (${columns.join(', ')}) VALUES (${placeholders})`;
      const orderParams = values;

      db.query(insertOrderSql, orderParams, (orderErr, orderResult) => {
        if (orderErr) return db.rollback(() => callback(orderErr));

        const orderId = orderResult.insertId;

        // If no items provided, just commit the order creation.
        if (!safeItems.length) {
          return db.commit((commitErr) => {
            if (commitErr) return db.rollback(() => callback(commitErr));
            callback(null, { orderId });
          });
        }

        const itemValues = safeItems.map((item) => [
          orderId,
          item.productId,
          item.quantity,
          item.price
        ]);

        const insertItemsSql = 'INSERT INTO order_items (orderId, productId, quantity, price) VALUES ?';
        db.query(insertItemsSql, [itemValues], (itemsErr) => {
          if (itemsErr) return db.rollback(() => callback(itemsErr));

          db.commit((commitErr) => {
            if (commitErr) return db.rollback(() => callback(commitErr));
            callback(null, { orderId });
          });
        });
      });
    });
  },

  updateOrder(id, orderData, items, callback) {
    this.getOrderById(id, (findErr, existing) => {
      if (findErr) return callback(findErr);
      if (!existing) return callback(null, null);

      const updatedOrder = {
        userId: orderData.userId != null ? orderData.userId : existing.userId,
        totalAmount: orderData.totalAmount != null ? orderData.totalAmount : existing.totalAmount,
        discountPercent: orderData.discountPercent != null ? orderData.discountPercent : existing.discountPercent,
        status: orderData.status != null ? orderData.status : existing.status,
        transactionId: orderData.transactionId != null ? orderData.transactionId : existing.transactionId,
        transactionRefId: orderData.transactionRefId != null ? orderData.transactionRefId : existing.transactionRefId,
        paymentMethod: orderData.paymentMethod != null ? orderData.paymentMethod : existing.paymentMethod
      };

      db.beginTransaction((txErr) => {
        if (txErr) return callback(txErr);

        const updateSql = 'UPDATE orders SET userId = ?, totalAmount = ?, discountPercent = ?, status = ?, transactionId = ?, transactionRefId = ?, paymentMethod = ? WHERE id = ?';
        const params = [
          updatedOrder.userId,
          updatedOrder.totalAmount,
          updatedOrder.discountPercent != null ? updatedOrder.discountPercent : 0,
          updatedOrder.status,
          updatedOrder.transactionId || null,
          updatedOrder.transactionRefId || null,
          updatedOrder.paymentMethod || null,
          id
        ];

        db.query(updateSql, params, (updateErr) => {
          if (updateErr) return db.rollback(() => callback(updateErr));

          const hasItems = Array.isArray(items);
          const replaceItems = hasItems && items.length >= 0;

          if (!replaceItems) {
            return db.commit((commitErr) => {
              if (commitErr) return db.rollback(() => callback(commitErr));
              callback(null, { id });
            });
          }

          const deleteSql = 'DELETE FROM order_items WHERE orderId = ?';
          db.query(deleteSql, [id], (deleteErr) => {
            if (deleteErr) return db.rollback(() => callback(deleteErr));

            if (items.length === 0) {
              return db.commit((commitErr) => {
                if (commitErr) return db.rollback(() => callback(commitErr));
                callback(null, { id });
              });
            }

            const values = items.map((item) => [
              id,
              item.productId,
              item.quantity,
              item.price
            ]);
            const insertSql = 'INSERT INTO order_items (orderId, productId, quantity, price) VALUES ?';
            db.query(insertSql, [values], (itemsErr) => {
              if (itemsErr) return db.rollback(() => callback(itemsErr));

              db.commit((commitErr) => {
                if (commitErr) return db.rollback(() => callback(commitErr));
                callback(null, { id });
              });
            });
          });
        });
      });
    });
  },

  deleteOrder(id, callback) {
    db.beginTransaction((txErr) => {
      if (txErr) return callback(txErr);

      const deleteItemsSql = 'DELETE FROM order_items WHERE orderId = ?';
      db.query(deleteItemsSql, [id], (itemsErr) => {
        if (itemsErr) return db.rollback(() => callback(itemsErr));

        const deleteOrderSql = 'DELETE FROM orders WHERE id = ?';
        db.query(deleteOrderSql, [id], (orderErr, result) => {
          if (orderErr) return db.rollback(() => callback(orderErr));
          if (result.affectedRows === 0) {
            return db.rollback(() => callback(null, null));
          }

          db.commit((commitErr) => {
            if (commitErr) return db.rollback(() => callback(commitErr));
            callback(null, { id });
          });
        });
      });
    });
  }
};

module.exports = OrderModel;
