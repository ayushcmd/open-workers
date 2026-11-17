import crypto from 'node:crypto';

const PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MIN_SECRET_LENGTH = 16;
const PREDICTABLE_SECRETS = new Set([
  'open-workers-preview-token-secret',
  'default',
  'secret',
  'changeme',
  'password',
  '12345678'
]);

/**
 * Error thrown when preview token secret is missing, weak, or predictable.
 */
export class PreviewTokenConfigError extends Error {
  constructor(message = 'Preview token signing secret is required but not configured.') {
    super(message);
    this.name = 'PreviewTokenConfigError';
    this.code = 'CONFIG_ERROR';
  }
}

/**
 * Validate that an explicit, strong server-side signing secret is provided.
 * Fails closed without leaking or printing secrets in logs or errors.
 *
 * @param {string|Buffer} secret
 * @returns {string} validated secret string
 */
export function validateSigningSecret(secret) {
  if (!secret || (typeof secret !== 'string' && !Buffer.isBuffer(secret))) {
    throw new PreviewTokenConfigError('Preview token signing secret is required but not configured.');
  }
  const secretStr = Buffer.isBuffer(secret) ? secret.toString('utf8') : String(secret).trim();
  if (secretStr.length === 0) {
    throw new PreviewTokenConfigError('Preview token signing secret is required but not configured.');
  }
  if (secretStr.length < MIN_SECRET_LENGTH) {
    throw new PreviewTokenConfigError(
      `Preview token signing secret is insufficient. Must be at least ${MIN_SECRET_LENGTH} characters.`
    );
  }
  if (PREDICTABLE_SECRETS.has(secretStr.toLowerCase())) {
    throw new PreviewTokenConfigError(
      'Preview token signing secret must not use predictable default values.'
    );
  }
  return secretStr;
}

/**
 * Derive a 256-bit HMAC key from an explicitly configured server-side secret.
 *
 * @param {string|Buffer} secret
 * @returns {Buffer}
 */
export function deriveKey(secret) {
  const validSecret = validateSigningSecret(secret);
  return crypto.createHash('sha256').update(validSecret, 'utf8').digest();
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
 * Requires a strong, explicitly configured server-side secret.
 *
 * @param {object} payload
 * @param {string|Buffer} secret
 * @param {number} [ttlMs]
 * @returns {string}
 */
export function createPreviewToken(payload, secret, ttlMs = PREVIEW_TOKEN_TTL_MS) {
  const key = deriveKey(secret);
  const now = Date.now();
  const data = {
    ...payload,
    iat: now,
    exp: now + ttlMs
  };
  const payloadB64 = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', key).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

/**
 * Verify and decode a preview token against a strong server-side secret.
 * Requires an explicitly configured server-side secret; fails closed if unavailable.
 *
 * @param {string} tokenStr
 * @param {string|Buffer} secret
 * @returns {{ valid: boolean, payload?: object, reason?: string }}
 */
export function verifyPreviewToken(tokenStr, secret) {
  const key = deriveKey(secret);

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

  const expectedSig = crypto.createHmac('sha256', key).update(payloadB64).digest('base64url');
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
