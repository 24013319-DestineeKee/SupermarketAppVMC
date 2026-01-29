const axios = require('axios');
const path = require('path');

const NETS_API =
  'https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets-qr/request';
const NETS_QUERY_API =
  'https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets-qr/query';

const loadCourseInitId = () => {
  try {
    const referencePath = path.join(__dirname, '..', 'course_init_id');
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const { courseInitId } = require(referencePath);
    return courseInitId ? `${courseInitId}` : '';
  } catch (error) {
    return '';
  }
};

const buildRequestPayload = (amount) => {
  const base = process.env.NETS_TXN_ID || 'sandbox_nets|m';
  const unique = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return {
    txn_id: `${base}|${unique}`,
    amt_in_dollars: Number(amount).toFixed(2),
    notify_mobile: 0
  };
};

const buildHeaders = () => ({
  'api-key': process.env.API_KEY,
  'project-id': process.env.PROJECT_ID
});

const buildWebhookUrl = (txnRetrievalRef, courseInitId) => {
  if (!txnRetrievalRef) return '';
  return `https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets/webhook?txn_retrieval_ref=${txnRetrievalRef}&course_init_id=${courseInitId}`;
};

const getPaymentStatus = async (txnRetrievalRef, frontendTimeoutStatus = 0) => {
  if (!process.env.API_KEY || !process.env.PROJECT_ID) {
    throw new Error('Missing NETS API configuration (API_KEY or PROJECT_ID).');
  }
  if (!txnRetrievalRef) {
    throw new Error('Missing NETS transaction reference.');
  }
  const payload = {
    txn_retrieval_ref: txnRetrievalRef,
    frontend_timeout_status: frontendTimeoutStatus
  };
  const response = await axios.post(NETS_QUERY_API, payload, {
    headers: {
      ...buildHeaders(),
      'Content-Type': 'application/json'
    },
    timeout: 7000
  });
  const data = response?.data?.result?.data || {};
  return {
    txnStatus: data.txn_status ?? data.txnStatus ?? data.status,
    responseCode: data.response_code || data.responseCode,
    txnRefId: data.txn_ref_id || data.txnRefId || data.txn_ref,
    raw: response?.data
  };
};

const requestQrCode = async (amount) => {
  if (!process.env.API_KEY || !process.env.PROJECT_ID) {
    throw new Error('Missing NETS API configuration (API_KEY or PROJECT_ID).');
  }

  const payload = buildRequestPayload(amount);
  const response = await axios.post(NETS_API, payload, { headers: buildHeaders() });
  const qrData = response?.data?.result?.data || {};
  const courseInitId = loadCourseInitId();

  return {
    qrData,
    txnId: payload.txn_id,
    webhookUrl: buildWebhookUrl(qrData.txn_retrieval_ref, courseInitId),
    courseInitId,
    fullResponse: response.data
  };
};

module.exports = {
  requestQrCode,
  getPaymentStatus
};
