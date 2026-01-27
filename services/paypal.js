const fetch = (...args) => {
  if (typeof global.fetch === 'function') return global.fetch(...args);
  return import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));
};
const PAYPAL_CLIENT = (process.env.PAYPAL_CLIENT_ID || '').trim();
const PAYPAL_SECRET = (process.env.PAYPAL_CLIENT_SECRET || '').trim();
const PAYPAL_ENVIRONMENT = (process.env.PAYPAL_ENVIRONMENT || 'SANDBOX').trim().toLowerCase();
const IS_LIVE_ENV = ['live', 'prod', 'production'].includes(PAYPAL_ENVIRONMENT);
const DEFAULT_PAYPAL_API = IS_LIVE_ENV
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';
const PAYPAL_API = (process.env.PAYPAL_API || '').trim() || DEFAULT_PAYPAL_API;

const ensureConfig = () => {
  if (!PAYPAL_CLIENT || !PAYPAL_SECRET || !PAYPAL_API) {
    throw new Error('Missing PayPal configuration. Please set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and PAYPAL_API.');
  }
};

async function getAccessToken() {
  ensureConfig();
  const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${PAYPAL_CLIENT}:${PAYPAL_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PayPal auth failed: ${response.status} ${text}`);
  }
  const data = await response.json();
  return data.access_token;
}

async function createOrder(amount) {
  ensureConfig();
  const accessToken = await getAccessToken();
  const response = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: 'SGD',
            value: amount
          }
        }
      ]
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PayPal createOrder failed: ${response.status} ${text}`);
  }
  return response.json();
}

async function captureOrder(orderId) {
  ensureConfig();
  const accessToken = await getAccessToken();
  const response = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PayPal captureOrder failed: ${response.status} ${text}`);
  }
  return response.json();
}

module.exports = {
  createOrder,
  captureOrder
};
