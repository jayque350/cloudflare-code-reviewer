/**
 * STARTER TRACK: Minimal 10-Minute Code Reviewer
 * 
 * A clean, single-file Cloudflare Worker that:
 * 1. Listens for GitHub pull_request webhooks
 * 2. Filters out lockfiles, configs, and assets (Alibaba OCR rule)
 * 3. Reviews the diff using Alibaba Qwen 2.5 Coder on Workers AI
 * 4. Posts inline review suggestions back to the GitHub PR
 * 
 * Run locally: npm run dev:starter
 * Deploy independently: npm run deploy:starter
 */

import parseDiff from 'parse-diff';
import { resolveGitHubToken, verifyWebhookSignature, type GitHubAppEnv } from './github-app-auth';

export interface Env extends GitHubAppEnv {
  AI: any;
  GITHUB_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  AI_GATEWAY_NAME?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Health check / GET handler
    if (request.method === 'GET') {
      return new Response(
        '🤖 Starter PR Reviewer is running! Point your GitHub webhook to POST /',
        { status: 200 }
      );
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Read the raw body once — needed verbatim for HMAC verification, then
    // parsed from that same string (calling request.json() first would
    // consume the stream and leave nothing for the signature check).
    const rawBody = await request.text();
    const signatureValid = await verifyWebhookSignature(
      env.GITHUB_WEBHOOK_SECRET,
      rawBody,
      request.headers.get('x-hub-signature-256')
    );
    if (!signatureValid) {
      return new Response('Invalid webhook signature', { status: 401 });
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    // Only review when a PR is opened or new commits are pushed
    if (!payload.pull_request || (payload.action !== 'opened' && payload.action !== 'synchronize')) {
      return new Response('Event ignored', { status: 200 });
    }

    const pr = payload.pull_request;

    // Resolved up front (not just before posting) because the diff fetch
    // below needs it too.
    const token = (await resolveGitHubToken(env, payload.installation?.id)) ?? env.GITHUB_TOKEN;

    // 1. Fetch the diff via the REST API (not the github.com "/pull/N.diff"
    // web route pr.diff_url points to) — a valid App installation token
    // still gets a 404 from that web route on a private repo, so this uses
    // the documented way to get a diff: GET the PR resource with the
    // v3.diff media type.
    const diffHeaders: Record<string, string> = {
      'User-Agent': 'Cloudflare-Starter-Reviewer',
      'Accept': 'application/vnd.github.v3.diff'
    };
    if (token) diffHeaders['Authorization'] = `token ${token}`;
    const diffApiUrl = `https://api.github.com/repos/${payload.repository.full_name}/pulls/${pr.number}`;
    const diffResponse = await fetch(diffApiUrl, { headers: diffHeaders });
    if (!diffResponse.ok) {
      return new Response(
        `Failed to fetch PR diff: ${diffResponse.status} ${diffResponse.statusText} from ${diffApiUrl}`,
        { status: 502 }
      );
    }
    const diffText = await diffResponse.text();

    // 2. Deterministic Filter: Skip lockfiles, bundles, and assets (Alibaba OCR principle)
    const files = parseDiff(diffText).filter(file => {
      const path = file.to || '';
      return !path.endsWith('.lock') &&
             !path.endsWith('.json') &&
             !path.endsWith('.yaml') &&
             !path.endsWith('.md') &&
             !path.includes('dist/') &&
             !path.includes('vendor/');
    });

    if (files.length === 0) {
      return new Response('No reviewable code files found.', { status: 200 });
    }

    // 3. Review code using Alibaba Qwen 2.5 Coder on Cloudflare Workers AI
    // Proxied through AI Gateway when AI_GATEWAY_NAME is set (dashboard: AI →
    // AI Gateway → Create Gateway) — turns on 24h caching for free.
    const diffHunk = JSON.stringify(files.slice(0, 5));
    const gatewayOpts = env.AI_GATEWAY_NAME
      ? { gateway: { id: env.AI_GATEWAY_NAME, cacheTtl: 86400 } }
      : undefined;
    const aiResponse = await env.AI.run('@cf/qwen/qwen2.5-coder-32b-instruct', {
      messages: [
        {
          role: 'system',
          content: `You are an automated code reviewer enforcing Alibaba Open-Code-Review standards.
Identify potential bugs, NPEs, race conditions, and unhandled errors.
For each issue, provide:
1. File and line number
2. Clear explanation of why it fails
3. Actionable fix using GitHub suggestion format:
\`\`\`suggestion
<corrected code>
\`\`\``
        },
        {
          role: 'user',
          content: `Review this parsed PR diff:\n${diffHunk}`
        }
      ]
    }, gatewayOpts);

    // 4. Post feedback back to GitHub PR — prefer a fresh GitHub App
    // installation token (persona: clawbuilders-code-reviewer[bot]) when
    // the App is configured, otherwise fall back to the plain PAT.
    // (token was resolved above, before the diff fetch.)
    if (!token) {
      // No secret configured yet — surface the review directly instead of
      // silently no-oping while still claiming success (the old behavior).
      return new Response(
        `GITHUB_TOKEN not set — skipping GitHub post. Review:\n\n${aiResponse.response}`,
        { status: 200 }
      );
    }

    const postRes = await fetch(pr.comments_url, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'Cloudflare-Starter-Reviewer',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        body: `### 🤖 Automated Code Review (Starter Track)\n*Powered by Cloudflare Workers AI (@cf/qwen/qwen2.5-coder-32b-instruct)*\n\n${aiResponse.response}`
      })
    });

    if (!postRes.ok) {
      // fetch() doesn't throw on 4xx/5xx — check explicitly, or a permission
      // gap (e.g. the App has pull_requests:write but not the issues:write
      // that this issue-comments endpoint actually requires) fails silently
      // while this handler still returns 200.
      const detail = await postRes.text();
      console.error(`Failed to post PR comment: ${postRes.status} ${postRes.statusText} — ${detail}`);
      return new Response(
        `GitHub rejected the comment post: ${postRes.status} ${postRes.statusText} — ${detail}`,
        { status: 502 }
      );
    }

    return new Response('Review posted successfully', { status: 200 });
  }
};
