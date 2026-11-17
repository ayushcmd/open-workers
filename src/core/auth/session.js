import crypto from 'node:crypto';

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret || 'open-workers-secret')).digest();
}

/**
 * Encrypt a session payload into a tamper-proof AES-256-GCM string.
 *
 * @param {object} payload
 * @param {string} secret
 * @param {number} [ttlMs]
 * @returns {string}
 */
export function encryptSession(payload, secret, ttlMs = DEFAULT_SESSION_TTL_MS) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const now = Date.now();
  const data = JSON.stringify({
    ...payload,
    iat: now,
    exp: now + ttlMs
  });

  const ciphertext = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('base64url')}.${authTag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

/**
 * Decrypt and verify an AES-256-GCM session token.
 *
 * @param {string} tokenStr
 * @param {string} secret
 * @returns {object|null}
 */
export function decryptSession(tokenStr, secret) {
  if (typeof tokenStr !== 'string' || !tokenStr.includes('.')) {
    return null;
  }
  const parts = tokenStr.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const [ivB64, tagB64, cipherB64] = parts;
    const iv = Buffer.from(ivB64, 'base64url');
    const authTag = Buffer.from(tagB64, 'base64url');
    const ciphertext = Buffer.from(cipherB64, 'base64url');

    if (iv.length !== 12 || authTag.length !== 16) {
      return null;
    }

    const key = deriveKey(secret);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const data = JSON.parse(decrypted);

    if (!data || typeof data !== 'object') {
      return null;
    }
    if (typeof data.exp === 'number' && data.exp <= Date.now()) {
      return null; // Expired
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Generate a random 32-byte hex state for OAuth CSRF protection.
 *
 * @returns {string}
 */
export function generateOAuthState() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create a signed OAuth state token containing state, return path, and expiration.
 *
 * @param {string} state
 * @param {string} returnTo
 * @param {string} secret
 * @param {number} [ttlMs]
 * @returns {string}
 */
export function signOAuthState(state, returnTo, secret, ttlMs = DEFAULT_STATE_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const payload = JSON.stringify({ state, returnTo: sanitizeReturnTo(returnTo), exp });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', deriveKey(secret)).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

/**
 * Verify and decode an OAuth state cookie value against the received state parameter.
 *
 * @param {string} cookieToken
 * @param {string} receivedState
 * @param {string} secret
 * @returns {{ valid: boolean, returnTo: string }}
 */
export function verifyOAuthState(cookieToken, receivedState, secret) {
  if (typeof cookieToken !== 'string' || !cookieToken.includes('.')) {
    return { valid: false, returnTo: '/app-install.html' };
  }
  const [payloadB64, signature] = cookieToken.split('.');
  if (!payloadB64 || !signature) {
    return { valid: false, returnTo: '/app-install.html' };
  }

  const expectedSig = crypto.createHmac('sha256', deriveKey(secret)).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSig);

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, returnTo: '/app-install.html' };
  }

  try {
    const data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!data || typeof data !== 'object') {
      return { valid: false, returnTo: '/app-install.html' };
    }
    if (typeof data.exp === 'number' && data.exp <= Date.now()) {
      return { valid: false, returnTo: '/app-install.html' };
    }
    if (data.state !== receivedState) {
      return { valid: false, returnTo: '/app-install.html' };
    }
    return { valid: true, returnTo: sanitizeReturnTo(data.returnTo) };
  } catch {
    return { valid: false, returnTo: '/app-install.html' };
  }
}

/**
 * Sanitize return URL to prevent open redirect vulnerabilities.
 * Only allows relative paths starting with / (excluding protocol-relative //).
 *
 * @param {string} [url]
 * @returns {string}
 */
export function sanitizeReturnTo(url) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.includes('\\')) {
    return '/app-install.html';
  }
  // Strip control characters
  const cleaned = url.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned || '/app-install.html';
}

/**
 * Parse standard HTTP Cookie header into key-value map.
 *
 * @param {string} [header]
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  const pairs = header.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      cookies[key] = decodeURIComponent(val);
    }
  }
  return cookies;
}

/**
 * Serialize a cookie for Set-Cookie header.
 *
 * @param {string} name
 * @param {string} value
 * @param {object} [options]
 * @returns {string}
 */
export function serializeCookie(name, value, options = {}) {
  const encVal = encodeURIComponent(value);
  let str = `${name}=${encVal}`;
  if (options.maxAge !== undefined) {
    str += `; Max-Age=${Math.floor(options.maxAge)}`;
  }
  str += `; Path=${options.path || '/'}`;
  if (options.httpOnly !== false) {
    str += '; HttpOnly';
  }
  if (options.sameSite) {
    str += `; SameSite=${options.sameSite}`;
  } else {
    str += '; SameSite=Lax';
  }
  if (options.secure) {
    str += '; Secure';
  }
  return str;
}
