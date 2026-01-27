const axios = require('axios');
const path = require('path');

const NETS_API =
  'https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets-qr/request';

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

const buildRequestPayload = (amount) => ({
  txn_id: process.env.NETS_TXN_ID || 'sandbox_nets|m|8ff8e5b6-d43e-4786-8ac5-7accf8c5bd9b',
  amt_in_dollars: Number(amount).toFixed(2),
  notify_mobile: 0
});

const buildHeaders = () => ({
  'api-key': process.env.API_KEY,
  'project-id': process.env.PROJECT_ID
});

const buildWebhookUrl = (txnRetrievalRef, courseInitId) => {
  if (!txnRetrievalRef) return '';
  return `https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets/webhook?txn_retrieval_ref=${txnRetrievalRef}&course_init_id=${courseInitId}`;
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
    webhookUrl: buildWebhookUrl(qrData.txn_retrieval_ref, courseInitId),
    courseInitId,
    fullResponse: response.data
  };
};

module.exports = {
  requestQrCode
};
