import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptSession,
  decryptSession,
  generateOAuthState,
  signOAuthState,
  verifyOAuthState,
  sanitizeReturnTo,
  parseCookies
} from '../src/core/auth/session.js';
import { createApp } from '../src/server.js';

describe('User Authorization & OAuth Session Engine (Core Crypto)', () => {
  const testSecret = 'test-encryption-key-for-open-workers-32b';

  it('encrypts and decrypts user session payloads with tamper resistance', () => {
    const payload = {
      login: 'alice',
      name: 'Alice Developer',
      avatarUrl: 'https://avatars.githubusercontent.com/u/12345',
      token: 'ghu_mock_user_access_token_123'
    };

    const token = encryptSession(payload, testSecret, 3600 * 1000);
    assert.strictEqual(typeof token, 'string');
    assert.strictEqual(token.split('.').length, 3);

    const decrypted = decryptSession(token, testSecret);
    assert.ok(decrypted);
    assert.strictEqual(decrypted.login, 'alice');
    assert.strictEqual(decrypted.name, 'Alice Developer');
    assert.strictEqual(decrypted.token, 'ghu_mock_user_access_token_123');
  });

  it('rejects tampered session tokens and invalid keys', () => {
    const token = encryptSession({ login: 'alice', token: 'secret' }, testSecret);
    const [iv, tag, cipher] = token.split('.');

    // Tampered ciphertext
    const tamperedCipher = Buffer.from(cipher, 'base64url');
    tamperedCipher[0] ^= 1;
    const tamperedToken = `${iv}.${tag}.${tamperedCipher.toString('base64url')}`;
    assert.strictEqual(decryptSession(tamperedToken, testSecret), null);

    // Wrong secret
    assert.strictEqual(decryptSession(token, 'completely-different-secret-key-32b'), null);

    // Garbage token
    assert.strictEqual(decryptSession('not.a.valid.token', testSecret), null);
    assert.strictEqual(decryptSession('', testSecret), null);
  });

  it('rejects expired session tokens', () => {
    // Negative TTL so it is already expired
    const expiredToken = encryptSession({ login: 'alice', token: 'secret' }, testSecret, -1000);
    assert.strictEqual(decryptSession(expiredToken, testSecret), null);
  });

  it('generates, signs, and verifies OAuth CSRF state tokens', () => {
    const state = generateOAuthState();
    const signed = signOAuthState(state, '/app-install.html', testSecret, 600 * 1000);

    const validResult = verifyOAuthState(signed, state, testSecret);
    assert.strictEqual(validResult.valid, true);
    assert.strictEqual(validResult.returnTo, '/app-install.html');

    // Mismatched state parameter (attacker CSRF attempt)
    const forgedResult = verifyOAuthState(signed, 'forged-state-string', testSecret);
    assert.strictEqual(forgedResult.valid, false);

    // Tampered signature
    const [payloadB64] = signed.split('.');
    assert.strictEqual(verifyOAuthState(`${payloadB64}.tamperedSig`, state, testSecret).valid, false);
  });

  it('sanitizes returnTo parameter to prevent open redirect vulnerabilities', () => {
    assert.strictEqual(sanitizeReturnTo('/app-install.html'), '/app-install.html');
    assert.strictEqual(sanitizeReturnTo('/community.html?repo=foo/bar'), '/community.html?repo=foo/bar');

    // Disallowed external or protocol-relative URLs
    assert.strictEqual(sanitizeReturnTo('https://evil.com'), '/app-install.html');
    assert.strictEqual(sanitizeReturnTo('//evil.com/app-install.html'), '/app-install.html');
    assert.strictEqual(sanitizeReturnTo('javascript:alert(1)'), '/app-install.html');
    assert.strictEqual(sanitizeReturnTo(null), '/app-install.html');
  });

  it('parses HTTP cookie headers safely', () => {
    const header = 'ow_session=abc123xyz; other=val%20with%20spaces; empty=';
    const parsed = parseCookies(header);
    assert.strictEqual(parsed.ow_session, 'abc123xyz');
    assert.strictEqual(parsed.other, 'val with spaces');
    assert.strictEqual(parsed.empty, '');
  });
});

describe('HTTP Integration: GitHub App OAuth & PR Authorization Flow', () => {
  const secretKey = 'test-secret-key-for-oauth-integration-32b';
  const mockClientId = 'Iv1.mock_client_id';
  const mockClientSecret = 'mock_client_secret_999';

  function createMockAuthApp(customInstallations = {}) {
    const env = {
      APP_URL: 'http://127.0.0.1:3000',
      GITHUB_CLIENT_ID: mockClientId,
      GITHUB_CLIENT_SECRET: mockClientSecret,
      SESSION_SECRET: secretKey
    };

    const mockInstallationOctokit = (permission = 'write') => ({
      rest: {
        repos: {
          getCollaboratorPermissionLevel: async ({ username }) => {
            if (customInstallations.permission) {
              return { data: { permission: customInstallations.permission } };
            }
            return { data: { permission } };
          },
          get: async () => ({
            data: { default_branch: 'main', archived: false }
          }),
          getBranch: async () => ({
            data: { commit: { sha: 'base_sha_123' } }
          }),
          getContent: async () => {
            const err = new Error('Not found');
            err.status = 404;
            throw err;
          },
          createOrUpdateFileContents: async () => ({
            data: { commit: { sha: 'commit_sha_new' } }
          })
        },
        git: {
          createRef: async () => ({ data: { ref: 'refs/heads/chore/add-license-mit' } }),
          getRef: async ({ ref } = {}) => {
            if (ref === 'heads/main' || ref === 'heads/master') {
              return { data: { object: { sha: 'base_sha_123' } } };
            }
            const err = new Error('Not found');
            err.status = 404;
            throw err;
          }
        },
        licenses: {
          getForRepo: async () => {
            const err = new Error('Not found');
            err.status = 404;
            throw err;
          }
        },
        pulls: {
          create: async () => ({
            data: { number: 42, html_url: 'https://github.com/mock/repo/pull/42' }
          })
        }
      }
    });

    const mockGithubContext = {
      appId: '12345',
      appSlug: 'open-workers',
      clientId: mockClientId,
      clientSecret: mockClientSecret,
      sessionSecret: secretKey,
      isAppConfigured: true,
      isWebhookConfigured: true,
      isOAuthConfigured: true,
      getInstallationUrl: () => 'https://github.com/apps/open-workers/installations/new',
      resolveRepoInstallation: async (owner, repo) => {
        if (customInstallations.missingInstallation) {
          return { installed: false, installation: null, octokit: null };
        }
        return {
          installed: true,
          installation: { id: 9999 },
          octokit: mockInstallationOctokit(customInstallations.permission || 'write')
        };
      }
    };

    const mockCreateUserClient = (token) => ({
      rest: {
        users: {
          getAuthenticated: async () => {
            if (token === 'invalid_or_expired_token') {
              const err = new Error('Bad credentials');
              err.status = 401;
              throw err;
            }
            if (token === 'bot_token') {
              return { data: { login: 'some-bot[bot]', type: 'Bot' } };
            }
            return {
              data: {
                login: customInstallations.login || 'verified-developer',
                type: 'User',
                name: 'Verified Developer'
              }
            };
          }
        }
      }
    });

    const mockFetchFn = async (url, options = {}) => {
      if (url === 'https://github.com/login/oauth/access_token') {
        const body = JSON.parse(options.body || '{}');
        if (body.code === 'valid_code') {
          return {
            ok: true,
            json: async () => ({ access_token: 'ghu_exchanged_token_456', token_type: 'bearer' })
          };
        }
        return {
          ok: false,
          json: async () => ({ error: 'bad_verification_code', error_description: 'Code is expired' })
        };
      }
      if (url === 'https://api.github.com/user') {
        return {
          ok: true,
          json: async () => ({
            login: 'verified-developer',
            type: 'User',
            name: 'Verified Dev',
            avatar_url: 'https://avatars.githubusercontent.com/u/999'
          })
        };
      }
      return fetch(url, options);
    };

    const { app } = createApp({
      env,
      githubContext: mockGithubContext,
      createUserClient: mockCreateUserClient,
      fetchFn: mockFetchFn,
      silentConfig: true
    });

    return { app, env, mockGithubContext };
  }

  it('GET /api/auth/status reflects unauthenticated state when no session cookie exists', async () => {
    const { app } = createMockAuthApp();
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.authenticated, false);
      assert.strictEqual(data.user, null);
      assert.strictEqual(data.isOAuthConfigured, true);
    } finally {
      server.close();
    }
  });

  it('GET /api/auth/github/login redirects to GitHub OAuth with CSRF state cookie', async () => {
    const { app } = createMockAuthApp();
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/github/login?returnTo=/app-install.html`, {
        redirect: 'manual'
      });
      assert.strictEqual(res.status, 302);
      const location = res.headers.get('location');
      assert.ok(location.startsWith('https://github.com/login/oauth/authorize'));
      assert.ok(location.includes(`client_id=${mockClientId}`));
      assert.ok(location.includes('state='));

      const setCookie = res.headers.get('set-cookie');
      assert.ok(setCookie.includes('ow_oauth_state='));
      assert.ok(setCookie.includes('HttpOnly'));
    } finally {
      server.close();
    }
  });

  it('GET /api/auth/github/callback rejects mismatched or forged state with 400', async () => {
    const { app } = createMockAuthApp();
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/auth/github/callback?code=valid_code&state=attacker_state`,
        {
          headers: { Cookie: 'ow_oauth_state=valid_cookie.fake_signature' }
        }
      );
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.code, 'INVALID_OAUTH_STATE');
    } finally {
      server.close();
    }
  });

  it('GET /api/auth/github/callback successfully sets session cookie on valid code', async () => {
    const { app } = createMockAuthApp();
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const state = 'legit_state_123';
      const stateCookieVal = signOAuthState(state, '/app-install.html', secretKey);

      const res = await fetch(
        `http://127.0.0.1:${port}/api/auth/github/callback?code=valid_code&state=${state}`,
        {
          headers: { Cookie: `ow_oauth_state=${stateCookieVal}` },
          redirect: 'manual'
        }
      );
      assert.strictEqual(res.status, 302);
      assert.ok(res.headers.get('location').includes('/app-install.html'));

      const cookies = res.headers.get('set-cookie');
      assert.ok(cookies.includes('ow_session='));
      assert.ok(cookies.includes('HttpOnly'));
    } finally {
      server.close();
    }
  });

  it('POST /api/trigger-pr succeeds with valid session cookie without manual token entry', async () => {
    const { app } = createMockAuthApp({ permission: 'write' });
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const sessionToken = encryptSession(
        { login: 'verified-developer', token: 'ghu_session_token' },
        secretKey
      );

      const res = await fetch(`http://127.0.0.1:${port}/api/trigger-pr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `ow_session=${sessionToken}`
        },
        body: JSON.stringify({
          repo: 'mock/repo',
          licenseId: 'MIT',
          holder: 'Acme Corp',
          year: '2026'
        })
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.pullNumber, 42);
      assert.ok(data.pullUrl);
    } finally {
      server.close();
    }
  });

  it('POST /api/trigger-pr rejects unauthorized user with 403 when user lacks write permission', async () => {
    const { app } = createMockAuthApp({ permission: 'read' });
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const sessionToken = encryptSession(
        { login: 'read-only-user', token: 'ghu_session_token' },
        secretKey
      );

      const res = await fetch(`http://127.0.0.1:${port}/api/trigger-pr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `ow_session=${sessionToken}`
        },
        body: JSON.stringify({
          repo: 'mock/repo',
          licenseId: 'MIT',
          holder: 'Acme Corp'
        })
      });

      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.code, 'FORBIDDEN');
      assert.ok(data.error.includes('Write access'));
    } finally {
      server.close();
    }
  });

  it('POST /api/trigger-pr rejects with 403 when App is not installed on repository', async () => {
    const { app } = createMockAuthApp({ missingInstallation: true });
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const sessionToken = encryptSession(
        { login: 'verified-developer', token: 'ghu_session_token' },
        secretKey
      );

      const res = await fetch(`http://127.0.0.1:${port}/api/trigger-pr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `ow_session=${sessionToken}`
        },
        body: JSON.stringify({
          repo: 'uninstalled/repo',
          licenseId: 'MIT',
          holder: 'Acme Corp'
        })
      });

      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.code, 'FORBIDDEN');
    } finally {
      server.close();
    }
  });

  it('POST /api/trigger-pr rejects with 401 when token is expired or invalid', async () => {
    const { app } = createMockAuthApp();
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const sessionToken = encryptSession(
        { login: 'verified-developer', token: 'invalid_or_expired_token' },
        secretKey
      );

      const res = await fetch(`http://127.0.0.1:${port}/api/trigger-pr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `ow_session=${sessionToken}`
        },
        body: JSON.stringify({
          repo: 'mock/repo',
          licenseId: 'MIT',
          holder: 'Acme Corp'
        })
      });

      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.strictEqual(data.code, 'AUTH_REQUIRED');
    } finally {
      server.close();
    }
  });

  it('never exposes clientSecret or privateKey in /api/config', async () => {
    const { app } = createMockAuthApp();
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`);
      const data = await res.json();
      assert.strictEqual(data.clientSecret, undefined);
      assert.strictEqual(data.privateKey, undefined);
      assert.strictEqual(data.sessionSecret, undefined);
      assert.strictEqual(data.isOAuthConfigured, true);
      assert.strictEqual(data.clientId, mockClientId);
    } finally {
      server.close();
    }
  });
});
