const Stripe = require('stripe');

const STRIPE_SECRET_KEY = (process.env.STRIPE_SECRET_KEY || '').trim();

const getClient = () => {
  if (!STRIPE_SECRET_KEY) {
    throw new Error('Missing Stripe configuration. Please set STRIPE_SECRET_KEY.');
  }
  return Stripe(STRIPE_SECRET_KEY);
};

const createPaymentIntent = async (amount, currency, metadata = {}) => {
  const client = getClient();
  const amountInCents = Math.round(Number(amount) * 100);
  if (!Number.isFinite(amountInCents) || amountInCents <= 0) {
    throw new Error('Invalid Stripe amount.');
  }
  return client.paymentIntents.create({
    amount: amountInCents,
    currency: (currency || 'sgd').toLowerCase(),
    metadata
  });
};

const getPaymentStatus = async (paymentIntentId) => {
  const client = getClient();
  const intent = await client.paymentIntents.retrieve(paymentIntentId);
  return intent?.status || 'unknown';
};

const getPaymentIntentDetails = async (paymentIntentId) => {
  const client = getClient();
  const intent = await client.paymentIntents.retrieve(paymentIntentId, {
    expand: ['latest_charge']
  });
  const latestCharge = intent?.latest_charge;
  const chargeId = typeof latestCharge === 'string'
    ? latestCharge
    : latestCharge?.id;
  return {
    status: intent?.status || 'unknown',
    chargeId: chargeId || null
  };
};

module.exports = {
  createPaymentIntent,
  getPaymentStatus,
  getPaymentIntentDetails
};
