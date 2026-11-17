import { Router } from 'express';
import {
  encryptSession,
  decryptSession,
  generateOAuthState,
  signOAuthState,
  verifyOAuthState,
  sanitizeReturnTo,
  parseCookies,
  serializeCookie
} from '../core/auth/session.js';

export function createAuthRouter({ githubContext, env = process.env, fetchFn = globalThis.fetch }) {
  const router = Router();
  const isProduction = env.NODE_ENV === 'production';
  const appUrl = (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

  function getBaseCallbackUrl(req) {
    if (env.APP_URL) {
      return `${appUrl}/api/auth/github/callback`;
    }
    const host = req.get('host') || 'localhost:3000';
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    return `${proto}://${host}/api/auth/github/callback`;
  }

  // GET /api/auth/status — Check current user session and OAuth availability
  router.get('/status', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies.ow_session;
    const session = sessionToken ? decryptSession(sessionToken, githubContext.sessionSecret) : null;

    res.json({
      authenticated: Boolean(session),
      user: session
        ? {
            login: session.login,
            name: session.name || session.login,
            avatarUrl: session.avatarUrl || null
          }
        : null,
      isOAuthConfigured: Boolean(githubContext.isOAuthConfigured),
      appSlug: githubContext.appSlug || 'open-workers',
      loginUrl: '/api/auth/github/login'
    });
  });

  // GET /api/auth/github/login — Initiate OAuth flow with CSRF protection
  router.get('/github/login', (req, res) => {
    if (!githubContext.isOAuthConfigured) {
      return res.status(503).json({
        error: 'GitHub OAuth is not configured on this host. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.',
        code: 'OAUTH_NOT_CONFIGURED'
      });
    }

    const returnTo = sanitizeReturnTo(req.query.returnTo);
    const state = generateOAuthState();
    const signedState = signOAuthState(state, returnTo, githubContext.sessionSecret);

    res.setHeader(
      'Set-Cookie',
      serializeCookie('ow_oauth_state', signedState, {
        maxAge: 600, // 10 minutes
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: isProduction
      })
    );

    const callbackUrl = getBaseCallbackUrl(req);
    const authUrl =
      'https://github.com/login/oauth/authorize' +
      `?client_id=${encodeURIComponent(githubContext.clientId)}` +
      `&redirect_uri=${encodeURIComponent(callbackUrl)}` +
      `&state=${encodeURIComponent(state)}` +
      '&scope=read:user';

    return res.redirect(302, authUrl);
  });

  // GET /api/auth/github/callback — Exchange OAuth code, verify user, set session cookie
  router.get('/github/callback', async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query;

    const cookies = parseCookies(req.headers.cookie);
    const stateCookie = cookies.ow_oauth_state;
    const verification = verifyOAuthState(stateCookie, typeof state === 'string' ? state : '', githubContext.sessionSecret);

    if (error) {
      const target = `${verification.returnTo}${verification.returnTo.includes('?') ? '&' : '?'}auth_error=${encodeURIComponent(String(errorDescription || error))}`;
      return res.redirect(302, target);
    }

    if (!verification.valid) {
      return res.status(400).json({
        error: 'Invalid or expired OAuth state parameter. Please try authenticating again.',
        code: 'INVALID_OAUTH_STATE'
      });
    }

    if (!code || typeof code !== 'string') {
      return res.status(400).json({
        error: 'Missing OAuth authorization code from GitHub.',
        code: 'MISSING_CODE'
      });
    }

    const callbackUrl = getBaseCallbackUrl(req);

    try {
      // Exchange authorization code for access token
      const tokenRes = await fetchFn('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Open-Workers'
        },
        body: JSON.stringify({
          client_id: githubContext.clientId,
          client_secret: githubContext.clientSecret,
          code,
          redirect_uri: callbackUrl
        })
      });

      const tokenData = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tokenData.access_token) {
        return res.status(400).json({
          error: tokenData.error_description || tokenData.error || 'Failed to exchange authorization code for token.',
          code: 'OAUTH_EXCHANGE_FAILED'
        });
      }

      const accessToken = tokenData.access_token;

      // Verify user profile and identity
      const userRes = await fetchFn('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Open-Workers'
        }
      });

      const userData = await userRes.json().catch(() => ({}));
      if (!userRes.ok || !userData.login) {
        return res.status(400).json({
          error: 'Unable to retrieve authenticated GitHub user profile.',
          code: 'USER_PROFILE_FAILED'
        });
      }

      if (userData.type && userData.type !== 'User') {
        return res.status(403).json({
          error: 'A human GitHub user account is required.',
          code: 'FORBIDDEN'
        });
      }

      // Encrypt session token into secure HTTP-only cookie
      const sessionPayload = {
        login: userData.login,
        name: userData.name || userData.login,
        avatarUrl: userData.avatar_url || null,
        token: accessToken
      };

      const encryptedSession = encryptSession(sessionPayload, githubContext.sessionSecret);

      const sessionCookie = serializeCookie('ow_session', encryptedSession, {
        maxAge: 7 * 24 * 60 * 60, // 7 days
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: isProduction
      });

      const clearStateCookie = serializeCookie('ow_oauth_state', '', {
        maxAge: 0,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: isProduction
      });

      res.setHeader('Set-Cookie', [sessionCookie, clearStateCookie]);

      const destination = `${verification.returnTo}${verification.returnTo.includes('?') ? '&' : '?'}auth=success`;
      return res.redirect(302, destination);
    } catch (err) {
      return res.status(500).json({
        error: `Authentication failed: ${err.message}`,
        code: 'AUTH_ERROR'
      });
    }
  });

  // POST /api/auth/logout — Invalidate user session
  router.post('/logout', (req, res) => {
    const clearCookie = serializeCookie('ow_session', '', {
      maxAge: 0,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: isProduction
    });
    res.setHeader('Set-Cookie', clearCookie);
    return res.json({ ok: true, authenticated: false });
  });

  return router;
}
