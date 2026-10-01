# S1:E5 Workshop: Building an Automated Code Review Agent with Cloudflare & Alibaba Open-Code-Review (OCR)

> **Event:** ClawBuilders S1:E5 — Deploy AI Agents with Cloudflare  
> **Format:** 3-Hour Hands-on Builder Meetup (Build • Deploy • Demo)  
> **Reference Architecture:** [alibaba/open-code-review](https://github.com/alibaba/open-code-review) + Cloudflare Workers, Durable Objects & Workers AI  

---

## 1. Executive Summary & Core Concept

This workshop guides developers through building and deploying a **24/7 automated GitHub Pull Request Review Agent** living entirely on the Cloudflare edge network.

Rather than building a standard chatbot, attendees build an edge-native developer tool inspired by **Alibaba's `open-code-review` (OCR)**—an internal tool battle-tested across millions of code changes before being open-sourced.

### Key Architectural Tenets
1. **Edge Ingress**: Cloudflare Workers handle GitHub webhook ingress with sub-5ms cold starts.
2. **State & Debounce**: SQLite-backed Durable Objects coordinate PR events, debouncing rapid commit pushes and preserving review conversation history.
3. **Multi-Model Committee**: Runs multiple specialized AI models concurrently (Security specialist + Code Quality specialist + Arbiter) using edge parallelization (`Promise.all()`).
4. **AI Gateway Proxy**: Provides unified model endpoints, 24-hour diff caching (0 token cost on repeated hunks), and automatic provider failover.
5. **Interactive MCP** *(stretch goal, not part of the guided build — see §7 Track 2)*: Exposes a Model Context Protocol endpoint so developers can question or challenge the reviewer directly inside local terminals via **Claude Code**, **Cursor**, or **Hermes Agent**.

---

## 2. Research: Alibaba `open-code-review` (OCR) Deep Dive

Alibaba open-sourced **`open-code-review` (OCR)** to solve the fundamental flaw of naive LLM code reviewers: **high hallucination rates, missing line context, and noisy nitpicks**.

### The Dual-Engine Philosophy
Alibaba divides code review into two distinct layers:

```
                  Raw GitHub Pull Request Diff
                               │
                               ▼
        ┌──────────────────────────────────────────────┐
        │        1. DETERMINISTIC "HARD RAILS"         │
        │ - Filter lockfiles, binaries, vendor files   │
        │ - Extract accurate file paths & line numbers │
        │ - AST rule-matching: NPEs, leaks, SQLi, XSS  │
        └──────────────────────┬───────────────────────┘
                               │ Curated Hunks & Hotspots
                               ▼
        ┌──────────────────────────────────────────────┐
        │       2. CONTEXT-AWARE LLM REASONING         │
        │ - Evaluate architectural intent & logic      │
        │ - Check boundary edge cases & concurrency    │
        │ - Output GitHub ```suggestion diff blocks    │
        └──────────────────────────────────────────────┘
```

### 1. Deterministic Pipeline ("Hard Rails")
*   **Aggressive Noise Filtering**: Automatically ignores lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`), build artifacts, compiled bundles (`dist/`), vendor packages, and generated documentation.
*   **Syntactic Anchoring**: Computes precise patch line numbers, preventing comments from drifting or failing to attach inline.
*   **Static Defect Rules**: Heuristically flags known critical anti-patterns before spending LLM tokens:
    *   Null Pointer Exceptions (NPE) and undefined property lookups.
    *   Thread-safety hazards and unhandled concurrency.
    *   Resource / connection leaks (unclosed sockets, unreleased file descriptors).
    *   SQL injection, command injection, and unsanitized HTML/XSS.

### 2. Context-Aware LLM Reasoning
*   Focuses the LLM's limited context window exclusively on high-signal modified hunks.
*   Enforces structured markdown outputs with GitHub suggestion blocks (` ```suggestion `), allowing developers to accept fixes with a single click.

---

## 3. The 7-Pillar Security Harness Suite (Each with its Own Specialty)

A Cloudflare Worker is a V8 isolate: it **cannot** spawn native binaries, so `gitleaks`, `semgrep`, and `opa` cannot literally run inside it without a paid [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) container. Rather than pretend otherwise, the reference implementation (`src/index.ts` in the [reference repo](https://github.com/Clawbuilders/cloudflare-code-reviewer)) is explicit about which pillars are genuinely live and which are honest heuristics:

- **REAL** — calls a live, free, public HTTP API. No binary required; this is exactly what a Worker can legitimately do on the free tier.
- **HEURISTIC** — a hand-rolled JS re-implementation of the named project's rule *ideas* (regex/path-matching), not the actual tool. Say this out loud when presenting — don't tell attendees it's literally running Semgrep or OPA, since it isn't.

| # | Security Harness & Repository | Kind | Specialty & Role in Review | Execution Layer |
|---|---|---|---|---|
| **1** | **[gitleaks/gitleaks](https://github.com/gitleaks/gitleaks)**-pattern scan (29k+ ★) | HEURISTIC | Regex/entropy rules modeled on gitleaks' public default ruleset. Halts and issues a critical block if hardcoded API keys, tokens, or private key blocks are detected. | Pre-LLM Edge Gate (Worker native, `scanForSecrets`) |
| **2** | **[osv.dev](https://osv.dev)** vulnerability lookup (Google) | **REAL** | New `package.json` dependencies are batch-queried live via `POST api.osv.dev/v1/querybatch` — real CVE/GHSA IDs come back, not a guess. Scoped to `package.json`; lockfiles need a real parser to do honestly, so they're out of scope here. | Pre-LLM Dependency Check (`checkOsvVulnerabilities`) |
| **3** | Hard-Rails file filter (Alibaba OCR-style) | HEURISTIC | Strips lockfiles, bundles, and vendor code before spending LLM tokens. Not a Semgrep integration — SAST-style reasoning happens in the LLM pass (Pillar 5). | Pre-LLM Filter |
| **4** | **[open-policy-agent/opa](https://github.com/open-policy-agent/opa)**-inspired policy gate (CNCF) | HEURISTIC | Flags PRs touching CI/CD workflows (`.github/workflows/`), auth code, or infra config, and PRs over a blast-radius file-count threshold. Real OPA is a legitimate stretch goal: compile a Rego policy to WASM (`opa build -t wasm`) and evaluate it with [`@open-policy-agent/opa-wasm`](https://github.com/open-policy-agent/npm-opa-wasm) — not built here, since it needs a build step this workshop doesn't have time for. | Pre-LLM Policy Gate (`evaluateOpaPolicy`) |
| **5** | **[google/mantis](https://github.com/google/mantis)**-style reachability check | **REAL context** | Pulls the *full file* (not just the diff hunk) for up to 2 changed files via the GitHub Contents API at the PR's head commit, and hands it to DeepSeek-R1 so it can judge whether a flagged issue is actually reachable — not just pattern-matched in isolation. | Mid-Pipeline Context Fetch (`fetchFullFileContext`) |
| **6** | **[OWASP/Agent-Security-Regression-Harness](https://github.com/OWASP/Agent-Security-Regression-Harness)**-style regression gate | HEURISTIC | Lead Arbiter (Llama 3.3 70B) is instructed to verify the proposed fix introduces zero secondary vulnerabilities before posting. The real OWASP harness is an external, executable regression suite meant to run in CI against a deployed agent endpoint — a good companion GitHub Action, not something a Worker runs on itself. | Post-Generation Verification Layer |
| **7** | **[deps.dev](https://deps.dev)** OpenSSF Scorecard check (Google) | **REAL** | New dependencies are resolved to their source repo and checked live against the OpenSSF Scorecard (maintenance activity, code review practices, branch protection) via deps.dev's public API — bounded to 2 dependencies per run to keep the two-hop lookup fast. | Post-Dependency Supply-Chain Check (`checkSupplyChainScorecard`) |

---

## 4. Cloudflare Primitives & Free Tier Compatibility

The entire workshop runs on Cloudflare's **100% Free Tier** with zero credit card requirements:

| Cloudflare Primitive | Free Tier Allocation | Role in the Architecture |
|---|---|---|
| **Cloudflare Workers** | 100,000 requests/day | Instant webhook listener (`/webhook/github`) verifying GitHub HMAC signatures. |
| **Durable Objects (SQLite)** | Included on Workers Free Plan | Coordinates PR state, handles 15s commit debouncing, and stores review comment history in SQLite (`this.ctx.storage.sql`). |
| **Cloudflare AI Gateway** | 100% Free | Universal API gateway with zero-cost edge caching, analytics, rate limiting, and fallback routing. |
| **Workers AI** | 10,000 Neurons/day | Edge GPU inference running Alibaba Qwen 2.5 Coder and DeepSeek R1 for free. |
| **Model Context Protocol (MCP)** | Built-in SDK capability | Exposes `/mcp` so attendees can interrogate the reviewer from local agent tools. |
| **Cloudflare Sandboxes** | Paid ($5/mo container) | *Optional / Advanced only*. Free tier parses diffs via native TypeScript (`parse-diff`) inside Worker memory. |

---

## 5. Live Edge Models in Workers AI Catalog

Queried directly from Cloudflare's catalog (`wrangler ai models`):

*   **`@cf/qwen/qwen2.5-coder-32b-instruct`**: Alibaba's official code model, trained specifically for code generation, diff comprehension, and syntax corrections. **Free tier.**
*   **`@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`**: Reasoning model built for deep logic analysis, catching edge cases, memory leaks, and concurrency bugs. **Free tier.**
*   **`@cf/meta/llama-3.3-70b-instruct-fp8-fast`**: High-throughput 70B parameter model ideal for multi-agent synthesis and review arbitration. **Free tier.**
*   **`@cf/meta/llama-4-scout-17b-16e-instruct`**: Meta's 17B parameter MoE model (16 experts). **Free tier.**
*   **`@cf/moonshotai/kimi-k2.7-code`**: Long-context code model (262K context) for reviewing massive multi-file pull requests. **⚠️ Requires the Workers Paid plan or prepaid AI Gateway credits — not accessible on the free allowance.** Mention this as a "if your org has a paid Cloudflare account" stretch goal only; don't put it in front of attendees expecting a zero-cost demo.

All four free-tier models above draw from the same **10,000 Neurons/day** free allowance (§4) — plenty for a live demo evening, but mention this cap explicitly so no one is surprised if Neurons run out during the last few demos.

---

## 6. System Architecture: Multi-Harness + Multi-Model Pipeline

```
                 ┌──────────────────────────────────────────────┐
                 │              GitHub Repository               │
                 └──────┬───────────────────────────────▲───────┘
                        │ 1. PR Webhook (opened/sync)    │ 8. Post Validated Review
                        ▼                                │    with ```suggestion
                 ┌──────────────────────────────┐       │
                 │   Cloudflare Worker (Edge)   │       │
                 │   - Verifies HMAC signature  │       │
                 │   - Fast 200 OK to GitHub    │       │
                 └──────────────┬───────────────┘       │
                                │ 2. Route to PR DO     │
                                ▼                       │
                 ┌──────────────────────────────┐       │
                 │   Durable Object (SQLite)    │───────┘
                 │   - 15s Push Debounce Timer  │
                 │   - Review thread history    │
                 └──────┬───────────────────────┘
                        │ 3. Multi-Harness Evaluation Layer
         ┌──────────────────────┼──────────────────────┐
         ▼                      ▼                      ▼
┌───────────────────┐ ┌───────────────────┐ ┌──────────────────────┐
│  Harness 1: SAST  │ │  Harness 2: CVEs  │ │  Harness 3: Secrets  │
│  Semgrep Pattern  │ │  Google OSV       │ │  Gitleaks Heuristics │
│  Matching (NPE,   │ │  Scanner          │ │  (API Keys, Tokens,  │
│  SQLi, Leaks)     │ │  (Dependencies)   │ │  .env Leaks)         │
└─────────┬─────────┘ └─────────┬─────────┘ └──────────┬───────────┘
          │                     │                      │
          └─────────────────────┼──────────────────────┘
                                │ 4. Multi-Model Parallel Reasoning
         ┌──────────────────────┴──────────────────────┐
         ▼                                             ▼
┌───────────────────────────┐                 ┌───────────────────────────┐
│     Security Auditor      │                 │   Code Quality Reviewer   │
│  @cf/deepseek-ai/         │                 │  @cf/qwen/                │
│  deepseek-r1-distill-32b  │                 │  qwen2.5-coder-32b        │
│  + Google Mantis          │                 │  (Clean code, Refactors,  │
│  (Exploit Verification)   │                 │   GitHub ```suggestions)  │
└─────────────┬─────────────┘                 └─────────────┬─────────────┘
              │                                             │
              └──────────────────────┬──────────────────────┘
                                     │ 5. Specialist Reports
                                     ▼
                      ┌─────────────────────────────┐
                      │     Lead Review Arbiter     │
                      │  @cf/meta/llama-3.3-70b-fp8 │
                      │  (Deduplicates & Ranks)     │
                      └──────────────┬──────────────┘
                                     │ 6. Harness 4 Verification
                                     ▼
                      ┌─────────────────────────────┐
                      │    OWASP Agent Security     │
                      │      Regression Check       │
                      │  (No secondary vulns/leaks) │
                      └──────────────┬──────────────┘
                                     │ 7. Post to GitHub (loops back up to
                                     ▼  step "8." on the GitHub Repository box)

  Note: every env.AI.run() call above (steps 4-6, not just the last one) is
  actually proxied through Cloudflare AI Gateway — that's what turns on the
  24h diff cache, fallback routing, and observability, and it has to be
  passed as the 3rd argument on each individual call (see §7 Track 2 Step 2).

              ┌─────────────────────────────────────┐
              │   Local IDE (MCP) — STRETCH GOAL     │
              │   Claude Code / Cursor / Hermes      │
              │   Not built in the guided steps —    │
              │   see §7 Track 2 for pointers.        │
              └───────────────────────────────────────┘
```

---

## 7. Full Workshop Plan & Tracks

The workshop is split into two tracks:
*   **Starter Track**: Zero-to-hero in 10 minutes. 100% free, single worker, deployed live to `*.workers.dev`.
*   **Advanced Track**: Full Alibaba OCR architecture with stateful debouncing, multi-model committee, AI Gateway caching, and MCP terminal chat.

---

### Track 1: Starter Track ("Deploy in 10 Minutes")

**Goal:** Build a zero-cost GitHub PR Reviewer that parses diffs and posts inline suggestions using Alibaba Qwen 2.5 Coder.

#### Step 1: Initialize Project
```bash
npm create cloudflare@latest cf-pr-reviewer -- --template "cloudflare/workers-sdk/templates/experimental/worker-typescript"
cd cf-pr-reviewer
npm install parse-diff
```

#### Step 2: Configure Worker (`wrangler.json`)
```json
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cf-pr-reviewer",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-09",
  "ai": {
    "binding": "AI"
  }
}
```

#### Step 3: Implement Webhook & Review Logic (`src/index.ts`)
```typescript
import parseDiff from 'parse-diff';

export interface Env {
  AI: any;
  GITHUB_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const payload: any = await request.json();

    // Only process PR open or new commits pushed to the branch
    if (payload.action !== 'opened' && payload.action !== 'synchronize') {
      return new Response('Event ignored', { status: 200 });
    }

    const pr = payload.pull_request;

    // 1. Fetch raw diff directly from GitHub.
    // ⚠️ Private repo? This Authorization header is not optional. GitHub's
    // pull/N.diff route 404s with no auth on a private repo — and that 404
    // HTML page then parses as an empty diff below, so the whole review
    // silently no-ops with nothing to log. Works fine unauthenticated only
    // because a public demo repo doesn't need auth to read a diff at all.
    // See §8 Troubleshooting #7.
    const diffRes = await fetch(pr.diff_url, {
      headers: {
        'User-Agent': 'Cloudflare-PR-Reviewer',
        'Authorization': `token ${env.GITHUB_TOKEN}`
      }
    });
    const diffText = await diffRes.text();

    // 2. Deterministic Filter: Skip lockfiles, bundles, and assets (Alibaba OCR rule)
    const files = parseDiff(diffText).filter(file => {
      const path = file.to || '';
      return !path.endsWith('.lock') && 
             !path.endsWith('.json') && 
             !path.includes('dist/') && 
             !path.includes('vendor/');
    });

    if (files.length === 0) {
      return new Response('No reviewable files found.', { status: 200 });
    }

    // 3. Review code with Alibaba Qwen 2.5 Coder on Workers AI
    const review = await env.AI.run('@cf/qwen/qwen2.5-coder-32b-instruct', {
      messages: [
        {
          role: 'system',
          content: `You are an automated code reviewer enforcing Alibaba Open-Code-Review rules.
Analyze the diff for NPEs, security flaws, race conditions, and unhandled errors.
Format your review with clear file paths, line numbers, and actionable suggestions:
\`\`\`suggestion
<replacement code>
\`\`\``
        },
        { role: 'user', content: `Review this diff:\n${JSON.stringify(files.slice(0, 5))}` }
      ]
    });

    // 4. Post feedback back to GitHub PR
    await fetch(pr.comments_url, {
      method: 'POST',
      headers: {
        'Authorization': `token ${env.GITHUB_TOKEN}`,
        'User-Agent': 'Cloudflare-PR-Reviewer',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        body: `### 🤖 Automated Code Review (Cloudflare Workers AI × Alibaba Qwen 2.5 Coder)\n\n${review.response}`
      })
    });

    return new Response('Review posted successfully', { status: 200 });
  }
};
```

#### Step 4: Deploy Live
```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```
Copy the generated `*.workers.dev` URL and paste it into GitHub Repo Settings ➔ Webhooks (Event: `Pull requests`).

---

### Track 2: Advanced Track ("Multi-Model Committee & Stateful OCR")

**Goal:** Implement the full enterprise architecture:
1. **Durable Objects (`ctx.storage.sql`)**: 15s push debounce & review history.
2. **Multi-Model Committee**: DeepSeek R1 + Qwen 2.5 Coder evaluated concurrently via `Promise.all()`, synthesized by Llama 3.3 70B.
3. **AI Gateway**: 24h diff caching and provider failover.
4. **Model Context Protocol (MCP)** *(stretch goal — not built in Step 2 below)*: exposing a `/mcp` endpoint so attendees can question the reviewer from Claude Code/Cursor is a great "if you finish early" extension, but it isn't part of the guided build. Don't schedule it into the 105-minute build block as if it were — point fast finishers at the [Cloudflare Agents SDK MCP docs](https://developers.cloudflare.com/agents/model-context-protocol/) instead.

#### Step 1: Configure Durable Objects & AI Gateway (`wrangler.json`)

First create the gateway once in the dashboard (**AI** → **AI Gateway** → **Create Gateway**), then reference its name as a var:

```json
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cf-pr-reviewer-advanced",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-09",
  "ai": {
    "binding": "AI"
  },
  "vars": {
    "AI_GATEWAY_NAME": "cf-pr-reviewer"
  },
  "durable_objects": {
    "bindings": [
      { "name": "PR_COORDINATOR", "class_name": "PrReviewCoordinator" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["PrReviewCoordinator"] }
  ]
}
```

#### Step 2: Implementation (`src/index.ts`)
```typescript
import { DurableObject } from 'cloudflare:workers';
import parseDiff from 'parse-diff';

export interface Env {
  AI: any;
  PR_COORDINATOR: DurableObjectNamespace;
  GITHUB_TOKEN: string;
  AI_GATEWAY_NAME: string; // create this once in the dashboard: AI Gateway → Create Gateway
}

// ── Ingress Worker ────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return new Response('OK');

    const payload: any = await request.json();
    if (payload.action !== 'opened' && payload.action !== 'synchronize') {
      return new Response('Ignored', { status: 200 });
    }

    // Unique Durable Object instance per Pull Request
    const prId = `${payload.repository.full_name}#${payload.pull_request.number}`;
    const id = env.PR_COORDINATOR.idFromName(prId);
    const stub = env.PR_COORDINATOR.get(id);

    return stub.fetch(new Request('https://internal/queue-review', {
      method: 'POST',
      body: JSON.stringify(payload)
    }));
  }
};

// ── Durable Object: State, Debounce & Multi-Model Execution ────────────────────
// Note: current Cloudflare guidance is to read state off `this.ctx` (inherited
// from the DurableObject base class) rather than re-assigning it to a private
// field — `this.ctx` is already there for you once you call `super(ctx, env)`.
export class PrReviewCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema setup only — wrap in blockConcurrencyWhile so no request is
    // served against a table that hasn't been created yet.
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          commit_sha TEXT,
          summary TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const payload: any = await request.json();
    const pr = payload.pull_request;

    // 1. Debounce rapid pushes: Reset alarm for 15 seconds
    await this.ctx.storage.setAlarm(Date.now() + 15000);
    await this.ctx.storage.put('pending_pr', pr);

    return new Response(JSON.stringify({ status: 'queued', debounce: 15 }), { status: 200 });
  }

  // Executes automatically after 15 seconds of silence (no new pushes)
  async alarm() {
    const pr: any = await this.ctx.storage.get('pending_pr');
    if (!pr) return;

    // 1. Fetch & Parse Diff.
    // ⚠️ Private repo? This Authorization header is not optional — see the
    // comment on the Starter Track's equivalent fetch above, and §8
    // Troubleshooting #7. Once you wire up the GitHub App in Step 3 below,
    // prefer the REST API over this .diff web route entirely: even a valid
    // App installation token doesn't reliably get honored by
    // pull/N.diff on a private repo. Use
    // `GET /repos/{owner}/{repo}/pulls/{number}` with
    // `Accept: application/vnd.github.v3.diff` instead — see
    // `src/index.ts` in this repo for the reference implementation.
    const diffText = await fetch(pr.diff_url, {
      headers: {
        'User-Agent': 'Cloudflare-Reviewer-Bot',
        'Authorization': `token ${this.env.GITHUB_TOKEN}`
      }
    }).then(r => r.text());

    const files = parseDiff(diffText).filter(
      f => !f.to?.endsWith('.lock') && !f.to?.endsWith('.json') && !f.to?.includes('dist/')
    );
    const diffPayload = JSON.stringify(files.slice(0, 5));

    // Every AI Gateway option below is what actually turns on the 24h cache,
    // analytics, and fallback routing claimed in §1/§4 — without the third
    // `{ gateway: { id } }` argument, env.AI.run() calls Workers AI *directly*
    // and none of that applies. This is the one part of the pipeline that's
    // easy to build and forget to wire up, so don't skip it live.
    const gatewayOpts = { gateway: { id: this.env.AI_GATEWAY_NAME, cacheTtl: 86400 } };

    // 2. Parallel Multi-Model Committee (Zero added latency)
    const [securityCheck, codeCheck] = await Promise.all([
      // Specialist 1: DeepSeek R1 for deep vulnerability and race condition analysis
      this.env.AI.run('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', {
        messages: [
          { role: 'system', content: 'You are an adversarial security auditor. Flag only high-severity logic bugs, memory leaks, NPEs, or race conditions.' },
          { role: 'user', content: diffPayload }
        ]
      }, gatewayOpts),

      // Specialist 2: Alibaba Qwen 2.5 Coder for code correctness & replacement syntax
      this.env.AI.run('@cf/qwen/qwen2.5-coder-32b-instruct', {
        messages: [
          { role: 'system', content: 'You are a staff software engineer. Suggest clean, idiomatic improvements with ```suggestion blocks.' },
          { role: 'user', content: diffPayload }
        ]
      }, gatewayOpts)
    ]);

    // 3. Lead Arbiter: Synthesize reports & remove false alarms, proxied via AI Gateway
    const finalReview = await this.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        {
          role: 'system',
          content: `You are the Lead Code Review Arbiter. You received reports from two specialized AI reviewers:
Security Reviewer:
${securityCheck.response}

Code Quality Reviewer:
${codeCheck.response}

Task:
- Deduplicate overlapping points.
- Discard trivial nitpicks or speculative false alarms.
- Output a polished, executive review ready for GitHub with [CRITICAL], [WARNING], and [IMPROVEMENT] tags.`
        },
        { role: 'user', content: `Original Diff:\n${diffPayload}` }
      ]
    }, gatewayOpts);

    // 4. Save review in SQLite memory
    this.ctx.storage.sql.exec(
      'INSERT INTO reviews (commit_sha, summary) VALUES (?, ?)',
      pr.head.sha,
      finalReview.response
    );

    // 5. Post final synthesis to GitHub PR
    await fetch(pr.comments_url, {
      method: 'POST',
      headers: {
        'Authorization': `token ${this.env.GITHUB_TOKEN}`,
        'User-Agent': 'Cloudflare-PR-Reviewer',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        body: `### 🛡️ AI Review Committee Report\n*Analyzed by DeepSeek-R1 + Qwen 2.5 Coder • Synthesized by Llama 3.3 70B*\n\n${finalReview.response}`
      })
    });

    await this.ctx.storage.delete('pending_pr');
  }
}
```

#### Step 3: Configure the GitHub App (Advanced Track is App-only)

Unlike the Starter Track's simple PAT, the Advanced Track posts exclusively as a real bot identity — a GitHub App, not your personal account. This takes about five extra minutes and is worth doing properly; the steps below are exactly what worked (and what didn't) building the reference deployment.

1. **Register the App under your org, not your personal account** — `github.com/organizations/<your-org>/settings/apps/new`. (No org? A personal account works too, just skip the org-scoping steps below.)
2. **Name it without "bot" in the name** — GitHub auto-appends `[bot]` to whatever you pick, so `cf-pr-reviewer` already shows up as `cf-pr-reviewer[bot]` in comments. Adding "-bot" yourself just doubles it up.
3. **Skip "Identifying and authorizing users" entirely** — delete the empty Redirect URI row if one appears. A bot posting under its own identity needs no OAuth user-login flow.
4. **Webhook**: Active, URL = your deployed worker's `/webhook/github` endpoint. Generate a webhook secret and save it somewhere immediately — GitHub only shows it once.
5. **Permissions**: expand Repository permissions, set only **Contents → Read-only** and **Pull requests → Read and write**. Leave Organization/Account/Enterprise permissions alone.
6. **The step everyone misses**: setting the Pull Requests permission does *not* automatically subscribe you to the `pull_request` event. Scroll down to **Subscribe to events** — a new "Pull request" checkbox appears there once the permission above is set — and check it. Skip this and GitHub delivers **nothing**, with no error anywhere. (See Troubleshooting #5 below for how to actually diagnose this if it happens to you.)
7. **Where can this be installed?** → Only on this account.
8. Click **Create GitHub App**, then **Generate a private key** — this downloads a `.pem` file. Note the **App ID** shown on the same page (not sensitive, fine to write down).
9. **Install the App** on just the target repo(s) — left sidebar → Install App.

Then wire it into the Worker:

```bash
# GitHub Apps generate PKCS#1 keys; Web Crypto's importKey('pkcs8', ...)
# needs PKCS#8 — convert once, locally:
openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out pkcs8-key.pem
```

Set two Worker secrets (dashboard: Settings → Variables and Secrets → Add → type **Secret**, or `npx wrangler secret put <NAME>`):
- `GITHUB_APP_PRIVATE_KEY` — the full contents of the converted `pkcs8-key.pem` file.
- `GITHUB_WEBHOOK_SECRET` — the secret from step 4.

(`GITHUB_APP_ID` isn't sensitive — bake it straight into `wrangler.json`'s `vars` instead of a secret, one less thing to configure.)

At runtime, the Worker never needs a hardcoded installation ID — it reads `payload.installation.id` straight off every webhook delivery, since App webhooks are already scoped per-installation. It signs a JWT with the private key, exchanges it for a short-lived (~1h) installation access token, and posts with that instead of a personal token. See `src/github-app-auth.ts` in the reference repo for the full implementation — it's ~120 lines of plain Web Crypto (`crypto.subtle`), no npm dependencies.

> **Never let raw private-key material pass through a chat/AI coding assistant.** Copy it directly from the local `.pem` file into the Cloudflare dashboard. If it ever does end up pasted into a chat session, treat it as compromised immediately and rotate it — Generate a new private key on the App's settings page invalidates the old one instantly.

---

> **This is the teaching version — the deployed reference repo goes further.** `src/index.ts` in [Clawbuilders/cloudflare-code-reviewer](https://github.com/Clawbuilders/cloudflare-code-reviewer) additionally implements the two **REAL** pillars from §3 as working code, not prompts: a live `POST api.osv.dev/v1/querybatch` lookup for new `package.json` dependencies (Pillar 2), a live deps.dev OpenSSF Scorecard check (Pillar 7), and a GitHub Contents API fetch that hands the security model full file context instead of just the diff hunk (Pillar 5, Mantis-style reachability). All three are pure `fetch()` calls — no new dependencies, nothing that needs a native binary. If you have time in the Advanced Track, walk attendees through `checkOsvVulnerabilities()` and `checkSupplyChainScorecard()` in the repo directly; they're short, and seeing the pipeline return a *real* CVE ID lands better than a simulated one.

> **Caveat — "one-click suggestion blocks" isn't literal here.** Both tracks post the review as a single **issue comment** via `pr.comments_url`. That's the right call for a 3-hour workshop (one POST, no diff-position math), and the ` ```suggestion ` fence still renders as a readable diff block in the comment body — but GitHub's actual one-click "Add suggestion to batch" button only appears on comments created through the **Pull Request Review Comments API** (`POST /repos/{owner}/{repo}/pulls/{pull_number}/comments`), anchored to a specific `commit_id` + `path` + `line`. Say this explicitly when you demo it, so nobody spends the demo slot hunting for a button that isn't there. Wiring up real inline suggestions is a good stretch-goal callout for advanced-track attendees who finish early.

---

## 8. Facilitator Guide & Workshop Operations

### Schedule Breakdown (180 Minutes)
*   **0:00 – 0:30 (Check-in & Intros)**: Attendees get settled, grab food, and confirm prerequisites (`wrangler`, `Node.js 18+`, GitHub accounts).
*   **0:30 – 0:45 (Architecture Presentation)**: 
    *   Explain the Alibaba OCR dual-engine concept (Hard Rails + LLM Reasoning).
    *   Walk through Workers AI models (`qwen2.5-coder`, `deepseek-r1`) and AI Gateway caching.
*   **0:45 – 2:30 (Hands-on Hacking Session)**:
    *   Attendees choose Starter Track or Advanced Track.
    *   Mentors float around to unblock GitHub token permissions and webhook setups.
*   **2:30 – 2:55 (Live Community Demos)**:
    *   Builders project their screens, submit a pull request with an intentional bug (e.g. unhandled NPE or SQL injection), and watch their live Cloudflare agent catch and fix it in real-time.
*   **2:55 – 3:00 (Wrap-up & Group Photo)**.

### Common Troubleshooting Points
1. **GitHub Webhook Times Out**: GitHub requires an HTTP response within 10 seconds. The Worker acknowledges with `200 OK` immediately upon ingress and delegates work to the Durable Object alarm asynchronously.
2. **Missing SQLite Migration**: Ensure `wrangler.json` includes `new_sqlite_classes: ["PrReviewCoordinator"]` under migrations.
3. **GitHub API Permissions**: a classic Personal Access Token needs the `repo` scope; a fine-grained PAT needs **Pull requests: Read and write** (and **Contents: Read** to fetch `diff_url`) on the target repo.
4. **Setting `GITHUB_TOKEN` without the CLI (Starter Track only — Advanced is App-only, see #5 and #6 below)**: `npx wrangler secret put GITHUB_TOKEN` works, but attendees who'd rather not paste a token into a terminal prompt can use the dashboard instead — Workers & Pages → their worker → Settings → Variables and Secrets → Add → type **Secret**, name `GITHUB_TOKEN`. **The secret is per-worker, not per-repo**: the worker without it still returns `200` and silently skips the GitHub post instead of erroring, which is a confusing thing to debug live.
5. **Advanced Track: webhook fires but total silence, no error anywhere**: check the App's own **Settings → Advanced → Recent Deliveries** log first — not the Worker's own logs, which show nothing because nothing ever arrived. If Recent Deliveries is empty even after a real push, the "Pull request" checkbox under Subscribe to events (App setup Step 3.6 above) almost certainly never got saved. Fix it there and click Save — GitHub re-applies it immediately for an App you own, no separate re-approval needed.
6. **`GITHUB_APP_PRIVATE_KEY` rejected / signing fails**: the key GitHub gives you is PKCS#1 (`BEGIN RSA PRIVATE KEY`); Cloudflare Workers' Web Crypto needs PKCS#8 (`BEGIN PRIVATE KEY`). Convert with `openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out pkcs8-key.pem` and paste the converted file's contents instead.
7. **Private repo: webhook fires, Alarm/invocation logs "Ok", nothing ever posts, and there's no error anywhere** — this is the private-vs-public-repo gotcha, and it bit the reference deployment in production before it was diagnosed and fixed:
   - **Cause #1 — unauthenticated diff fetch.** `pr.diff_url` (`github.com/OWNER/REPO/pull/N.diff`) works with *no* auth header for a **public** repo, which is why a workshop demo against a public repo (or this repo's own public demo PRs) looks fine even with the header missing. Point the same code at a **private** repo and that same request 404s. The 404 HTML page then parses as zero changed files via `parseDiff()`, which every track's "no reviewable files" early-return treats as "nothing to review" — not as an error. Fix: always send `Authorization: token <...>` on the diff fetch, the same as you already do on the comment-posting fetch (both tutorial snippets above now show this).
   - **Cause #2 — even with a valid GitHub App installation token, that same `.diff` web route can still 404 on a private repo.** It doesn't reliably honor App tokens the way the REST API does. If you're on the Advanced Track's App-based auth (Step 3 below), skip `pr.diff_url` entirely and fetch `GET https://api.github.com/repos/{owner}/{repo}/pulls/{number}` with header `Accept: application/vnd.github.v3.diff` instead — that's the documented, App-token-safe way to get a diff. See `src/index.ts` in this repo for the reference implementation (and `starter/src/index.ts`, which needs the same fix if you're combining the Starter Track's simplicity with an App instead of a plain PAT).
   - **Either way, don't let this fail silently again**: check `diffResponse.ok` before parsing, and `console.error` (plus, for the comment-post fetch, the same check) on a non-2xx — a plain `fetch()` never throws on 4xx/5xx, so an unchecked response looks identical to success in every log you have.
