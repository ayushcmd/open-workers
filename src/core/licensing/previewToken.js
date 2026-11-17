import crypto from 'node:crypto';

const PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret || 'open-workers-preview-token-secret')).digest();
}

/**
 * Compute a deterministic SHA-256 hash of a content string.
 *
 * @param {string} content
 * @returns {string} hex digest
 */
export function computeContentHash(content) {
  return crypto.createHash('sha256').update(typeof content === 'string' ? content : '', 'utf8').digest('hex');
}

/**
 * Create a signed, tamper-proof stateless preview token.
 *
 * @param {object} payload
 * @param {string} [secret]
 * @param {number} [ttlMs]
 * @returns {string}
 */
export function createPreviewToken(payload, secret, ttlMs = PREVIEW_TOKEN_TTL_MS) {
  const now = Date.now();
  const data = {
    ...payload,
    iat: now,
    exp: now + ttlMs
  };
  const payloadB64 = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', deriveKey(secret)).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

/**
 * Verify and decode a preview token against a secret.
 *
 * @param {string} tokenStr
 * @param {string} [secret]
 * @returns {{ valid: boolean, payload?: object, reason?: string }}
 */
export function verifyPreviewToken(tokenStr, secret) {
  if (typeof tokenStr !== 'string' || !tokenStr.includes('.')) {
    return { valid: false, reason: 'MALFORMED_TOKEN' };
  }
  const parts = tokenStr.split('.');
  if (parts.length !== 2) {
    return { valid: false, reason: 'MALFORMED_TOKEN' };
  }
  const [payloadB64, signature] = parts;
  if (!payloadB64 || !signature) {
    return { valid: false, reason: 'MALFORMED_TOKEN' };
  }

  const expectedSig = crypto.createHmac('sha256', deriveKey(secret)).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSig);

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, reason: 'INVALID_SIGNATURE' };
  }

  try {
    const data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!data || typeof data !== 'object') {
      return { valid: false, reason: 'INVALID_PAYLOAD' };
    }
    if (typeof data.exp === 'number' && data.exp <= Date.now()) {
      return { valid: false, reason: 'EXPIRED' };
    }
    return { valid: true, payload: data };
  } catch {
    return { valid: false, reason: 'PARSE_ERROR' };
  }
}
