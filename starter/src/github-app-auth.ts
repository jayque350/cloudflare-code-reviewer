/**
 * Shared helpers for authenticating as a GitHub App instead of a static PAT.
 * Self-contained (no npm deps) — Cloudflare Workers support RS256 signing
 * and HMAC natively via Web Crypto (`crypto.subtle`).
 *
 * Duplicated between starter/src and the repo-root src on purpose: each
 * track's directory has to stay fully self-contained (its own package.json
 * and dependencies) so Cloudflare's Deploy to Workers button can target
 * either one independently — see README.md's "One-Click Deploy" section.
 */

export interface GitHubAppEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
}

function base64UrlEncode(input: ArrayBuffer | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// GitHub Apps generate PKCS#1 keys ("BEGIN RSA PRIVATE KEY"). Web Crypto's
// importKey('pkcs8', ...) needs PKCS#8 ("BEGIN PRIVATE KEY"). Convert once,
// locally, before pasting the key into the GITHUB_APP_PRIVATE_KEY secret:
//   openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out pkcs8-key.pem
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  if (pem.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error(
      'GITHUB_APP_PRIVATE_KEY is PKCS#1 ("BEGIN RSA PRIVATE KEY") — Web Crypto needs PKCS#8. ' +
        'Convert it first: openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out pkcs8-key.pem'
    );
  }
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

async function createAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  // Backdate iat by 60s to tolerate clock drift, per GitHub's own guidance.
  const payload = { iat: now - 60, exp: now + 600, iss: appId };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

/** Exchange the App JWT for a short-lived (~1h) installation access token. */
async function getInstallationToken(appJwt: string, installationId: number): Promise<string> {
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Cloudflare-Code-Reviewer-App'
    }
  });
  if (!res.ok) {
    throw new Error(`Failed to mint installation token: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

export function hasAppCredentials(env: GitHubAppEnv): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
}

/**
 * Returns a token for `Authorization: token <...>` when posting to GitHub —
 * a fresh App installation token when GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY
 * are configured (requires `installationId`, read from the webhook
 * payload's `installation.id`), otherwise null so callers fall back to a
 * plain GITHUB_TOKEN PAT. Both auth methods stay supported on purpose: this
 * repo is both the live ClawBuilders showcase (App) and what workshop
 * attendees clone and deploy with their own PAT in ten minutes.
 */
export async function resolveGitHubToken(env: GitHubAppEnv, installationId: number | undefined): Promise<string | null> {
  if (!hasAppCredentials(env) || !installationId) return null;
  const jwt = await createAppJwt(env.GITHUB_APP_ID!, env.GITHUB_APP_PRIVATE_KEY!);
  return getInstallationToken(jwt, installationId);
}

/**
 * Verifies GitHub's `X-Hub-Signature-256` HMAC over the raw request body.
 * Only enforced when GITHUB_WEBHOOK_SECRET is configured — a manually
 * configured repo-level webhook (the Starter Track's documented path) may
 * not have one set, so this is opt-in hardening, not a hard requirement.
 */
export async function verifyWebhookSignature(
  secret: string | undefined,
  rawBody: string,
  signatureHeader: string | null
): Promise<boolean> {
  if (!secret) return true; // not configured — nothing to enforce
  if (!signatureHeader) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected =
    'sha256=' +
    Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  if (expected.length !== signatureHeader.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return mismatch === 0;
}
