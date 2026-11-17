/**
 * Open Workers — Client-Side Authentication Service
 *
 * Checks user authentication status, manages GitHub App OAuth flow,
 * and renders secure write-authorization controls.
 */

export async function getAuthStatus() {
  try {
    const res = await fetch('/api/auth/status', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) return { authenticated: false, isOAuthConfigured: false };
    return await res.json();
  } catch {
    return { authenticated: false, isOAuthConfigured: false };
  }
}

export async function logoutUser() {
  try {
    const res = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    });
    return res.ok;
  } catch {
    return false;
  }
}
