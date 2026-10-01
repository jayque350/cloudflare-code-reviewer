# Cloudflare Code Review Agent (Alibaba OCR + 7-Pillar Security Suite)

> A 24/7 automated GitHub PR code reviewer living on Cloudflare Workers, powered by SQLite Durable Objects, Workers AI, and inspired by **Alibaba's [open-code-review (OCR)](https://github.com/alibaba/open-code-review)** architecture guarded by a **7-Pillar Defense-in-Depth Suite**.

Built for [ClawBuilders](https://clawbuilder.club) S1:E5 — [Deploy AI Agents with Cloudflare](https://clawbuilder.club/events/s1/ep5/deploy-ai-agents-with-cloudflare).

---

## ⚡ One-Click Deploy to Cloudflare

Each track lives in its own fully self-contained directory, so Cloudflare's Deploy to Workers button can target either one directly and deploy *exactly* that track — not a mix of the two.

**Starter Track** (`starter/` — single-file reviewer, ten minutes to set up):

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/Clawbuilders/cloudflare-code-reviewer/tree/main/starter">
  <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy Starter Track to Cloudflare" height="38"/>
</a>

**Advanced Track** (repo root — full 7-pillar suite, Durable Objects, multi-model committee):

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/Clawbuilders/cloudflare-code-reviewer">
  <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy Advanced Track to Cloudflare" height="38"/>
</a>

> Each button's deploy command is auto-detected from that directory's own `package.json` (`npm run deploy`) — there's no shared root dependency between the two, so one button can never accidentally deploy the other track.

---

## 🛡️ The 7-Pillar Security Harness Suite

A Cloudflare Worker is a V8 isolate — it **cannot** execute native binaries (no `gitleaks`, `semgrep`, or `opa` executables) without a paid [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) container. So this pipeline is honest about what's actually running:

- **REAL** = calls a live, public, unauthenticated HTTP API. No binary needed — this is exactly what a free-tier Worker can legitimately do.
- **HEURISTIC** = a hand-rolled JS re-implementation of the named project's rule *ideas* (regex/path-matching), not the actual tool.

| # | Pillar & Repository | Kind | Specialty in the PR Agent Pipeline |
|---|---|---|---|
| **1** | 🔑 **[gitleaks/gitleaks](https://github.com/gitleaks/gitleaks)**-pattern scan | HEURISTIC | Zero-tolerance regex scan for hardcoded API keys, Stripe/AWS/Slack/GitHub tokens, private key blocks, and `.env` leaks. Blocks the PR outright if found. |
| **2** | 📦 **[osv.dev](https://osv.dev)** vulnerability lookup | **REAL** | New `package.json` dependencies are batch-queried live against Google's public OSV vulnerability database — real CVE/GHSA IDs, not a guess. |
| **3** | 🔍 Hard-Rails file filter (Alibaba OCR-style) | HEURISTIC | Strips lockfiles, bundles, and vendor code before spending LLM tokens. Not a Semgrep integration — SAST-style reasoning happens in the LLM pass (Pillar 5). |
| **3.5** | 🎯 **[typesafe/jev](https://developers.cloudflare.com/ai/models/typesafe/jev/)** triage gate | **REAL** | Cloudflare's calibrated decision model judges whether the diff needs the security specialist, the quality specialist, both, or neither — a docs-only or dependency-bump PR skips the multi-model committee entirely. A real OSV.dev/policy-gate finding always forces the security pass regardless of what Jev says; it can only add scrutiny, never suppress a deterministic one. |
| **4** | 🛡️ **[open-policy-agent/opa](https://github.com/open-policy-agent/opa)**-inspired policy gate | HEURISTIC | Flags changes to CI/CD workflows (`.github/workflows/`), auth code, or infra config, and PRs over a blast-radius file-count threshold. *(Real OPA is possible: compile a Rego policy to WASM with `opa build -t wasm` and evaluate it with [`@open-policy-agent/opa-wasm`](https://github.com/open-policy-agent/npm-opa-wasm) — a good stretch goal, not built here since it needs a build step.)* |
| **5** | 🧰 **[google/mantis](https://github.com/google/mantis)**-style reachability check | **REAL context** | Pulls the *full file* (not just the diff hunk) for changed files via the GitHub Contents API, so the security model can judge whether a flaw is actually reachable instead of pattern-matching a hunk in isolation. |
| **6** | 🧪 **[OWASP/Agent-Security-Regression-Harness](https://github.com/OWASP/Agent-Security-Regression-Harness)**-style regression gate | HEURISTIC | The Lead Arbiter (Llama 3.3 70B) is instructed to verify proposed fixes introduce zero secondary vulnerabilities before posting. *(The real OWASP harness is an external, executable regression suite meant to run in CI against a deployed agent endpoint — a good companion GitHub Action, not something that runs inside the Worker itself.)* |
| **7** | 📊 **[deps.dev](https://deps.dev)** OpenSSF Scorecard check | **REAL** | New dependencies are resolved to their source repo and checked live against the OpenSSF Scorecard (maintenance activity, code review practices, branch protection) via deps.dev's public API. |

---

## 🧠 Multi-Harness + Multi-Model Pipeline

```
                 GitHub PR Webhook
                         │
                         ▼
              Cloudflare Edge Worker
                         │
                         ▼
        Durable Object (PrReviewCoordinator)
         - 15s Push Debounce Timer
         - SQLite PR State & History
                         │
         ┌───────────────┼───────────────┬───────────────┐
         ▼               ▼               ▼               ▼
   [Pillar 1]      [Pillar 2]      [Pillar 3]      [Pillar 4]
  Gitleaks-pattern  osv.dev API    Hard-Rails      OPA-inspired
   Secret Scan     (REAL — CVEs)   File Filter    Policy/Blast Radius
  (heuristic)                     (heuristic)      (heuristic)
         │               │               │               │
         └───────────────┼───────────────┴───────────────┘
                         │
                         ▼
              [Pillar 7] deps.dev Scorecard
              (REAL — supply-chain check)
                         │
                         ▼
              [Pillar 3.5] Jev Triage Gate
         needs_security? needs_quality? category?
      (forced on by any real Pillar 2/4/7 finding)
                         │
      ┌──────────────────┴──────────────────┐
      │ Both skipped → short comment posted,│
      │ committee never runs (early return) │
      └──────────────────┬──────────────────┘
                         │ (at least one needed)
        ┌────────────────┴────────────────┐
        │ Parallel Review via Promise.all,│
        │ each proxied through AI Gateway │
        ▼                                 ▼
[Pillar 5: Security Specialist]   [Code Quality Specialist]
DeepSeek-R1 Distill               Alibaba Qwen 2.5 Coder
+ full-file context (REAL) for    (Clean Code & Diffs)
  Mantis-style reachability          (only if needs_quality)
     (only if needs_security)
        │                                 │
        └────────────────┬────────────────┘
                         │
                         ▼
                Lead Review Arbiter
                 Meta Llama 3.3 70B
     + [Pillar 6: OWASP-ASRH-style Regression]
            (Deduplicates & Removes Noise)
                         │
                         ▼
           GitHub PR Comment (```suggestion
             blocks — copy-paste, not a
             one-click Review API suggestion)
```

---

## 🧭 Two Tracks, Two Isolated Directories

### 1. 🚀 Starter Track (`starter/src/index.ts`)
*   **Concept**: Deploy your first automated PR reviewer in 10 minutes.
*   **Architecture**: Single stateless Cloudflare Worker + Workers AI (Alibaba Qwen 2.5 Coder). Its own `package.json`/`wrangler.json` — no dependency on the repo root.
*   **Run Locally**: `cd starter && npm install && npm run dev`
*   **Deploy**: `cd starter && npm run deploy` (or click the **Starter** button above!)

### 2. ⚡ Advanced Track (`src/index.ts` — repo root)
*   **Concept**: Full Alibaba OCR architecture with the 7-pillar security suite, SQLite Durable Objects, debouncing, and multi-model committee.
*   **Run Locally**: `npm run dev`
*   **Deploy**: `npm run deploy` (or click the **Advanced** button above!)

---

## 🚀 Local Quickstart

### 1. Clone

```bash
git clone https://github.com/Clawbuilders/cloudflare-code-reviewer.git
cd cloudflare-code-reviewer
```

Pick a track — each has its own dependencies, so `npm install` runs separately per directory.

**Starter Track:**
```bash
cd starter
npm install
npm run dev        # http://localhost:8787
```

**Advanced Track** (from the repo root instead):
```bash
npm install
npm run dev        # http://localhost:8787
```

### 2. Deploy to Cloudflare
```bash
npx wrangler login
npm run deploy      # run from starter/ or the repo root, depending on the track
```

### 3. Starter Track: Configure GitHub Token (Secret)

The Starter Track posts as *you* — a plain Personal Access Token, no app registration needed. A classic PAT needs the `repo` scope; a fine-grained PAT needs **Pull requests: Read and write** (plus **Contents: Read**) on the target repo.

**CLI** (run from `starter/`):
```bash
npx wrangler secret put GITHUB_TOKEN
```

**Or via the dashboard** (no terminal needed — useful if you'd rather not type a token into a CLI prompt):
1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages**.
2. Click into `cloudflare-code-reviewer-starter` → **Settings** tab → **Variables and Secrets** → **Add**.
3. Type **Secret** · Name `GITHUB_TOKEN` · Value your PAT → **Save and deploy**.

### 3b. Advanced Track: Configure the GitHub App (required — no PAT option)

The Advanced Track posts exclusively as a real bot identity — a GitHub App, not your personal account (`clawbuilders-code-reviewer[bot]` in the reference deployment). There's no PAT fallback here; the App is a required ~5-minute step, not optional. These are exactly the steps (and gotchas) from building the reference deployment:

1. Register under your **org** (not personal account): `github.com/organizations/<org>/settings/apps/new`.
2. Name it **without** "bot" in the name — GitHub auto-appends `[bot]` in comments (`cf-pr-reviewer` → `cf-pr-reviewer[bot]`).
3. Skip **Identifying and authorizing users** entirely (delete the empty Redirect URI row) — no OAuth user-login flow needed for a bot identity.
4. **Webhook**: Active, URL = your deployed worker's `/webhook/github`. Generate + save the webhook secret immediately — GitHub only shows it once.
5. **Permissions**: only **Contents → Read-only** and **Pull requests → Read and write**. Skip Organization/Account/Enterprise.
6. ⚠️ **The step everyone misses**: setting the Pull Requests permission does *not* auto-subscribe you to the `pull_request` event. A separate checkbox appears under **Subscribe to events** once that permission is set — check it, or GitHub delivers **nothing**, silently, forever. If this happens to you, diagnose it via the App's own **Settings → Advanced → Recent Deliveries** log (not the Worker's logs — nothing ever arrived there to log).
7. **Where can this be installed?** → Only on this account.
8. **Create GitHub App**, then **Generate a private key** (downloads a `.pem`) and note the **App ID** on the same page.
9. **Install App** on just the target repo(s).

Convert the key format — GitHub gives you PKCS#1, Cloudflare's Web Crypto needs PKCS#8:
```bash
openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out pkcs8-key.pem
```

Set two secrets on the **Advanced worker** (`cloudflare-code-reviewer`), same dashboard/CLI steps as above:
- `GITHUB_APP_PRIVATE_KEY` — full contents of the converted `pkcs8-key.pem`.
- `GITHUB_WEBHOOK_SECRET` — the secret from step 4.

`GITHUB_APP_ID` isn't sensitive — it's already baked into `wrangler.json`'s `vars`, no secret needed. `installation_id` isn't configured anywhere either — it arrives automatically on every webhook payload (`payload.installation.id`) since App webhooks are already scoped per-installation; see `src/github-app-auth.ts` for the JWT-signing + installation-token exchange (plain `crypto.subtle`, no npm deps).

`JEV_ESCALATION_FLOOR` (also a plain `wrangler.json` var, default `0.5`) is the Noul-probability floor the Jev triage gate uses to decide a diff needs a given specialist — lower it to run the committee more often (more cautious, more expensive), raise it to skip more aggressively. It's a starting point, not a validated threshold; tune it against this repo's own PR traffic before trusting it on anything that matters.

> **Never let raw private-key material pass through a chat/AI coding assistant** — copy it directly from the local file into the Cloudflare dashboard. If it ever leaks into a session anyway, treat it as compromised and rotate immediately (Generate a new private key invalidates the old one instantly).

### 3c. ⚠️ Private repos need one more thing than public repos do

Both tracks were originally built and demoed against **this repo**, which is public — a diff fetch against a public repo's `pr.diff_url` (`github.com/OWNER/REPO/pull/N.diff`) works with no auth header at all. Point either track at a **private** repo and that changes:

- **The diff fetch needs auth too, not just the comment post.** An unauthenticated request to a private repo's `pr.diff_url` returns a `404` — which is GitHub's HTML error page, not a diff. `parseDiff()` on that HTML yields zero files, and both tracks treat "zero reviewable files" as "nothing to review" and quietly stop. No exception, no failed request in your logs — the Worker looks like it ran fine. Fix: send the same `Authorization: token <...>` header on the diff fetch that you already send on the comment-posting fetch.
- **On the Advanced Track (GitHub App auth), that's still not enough.** Even a real, successfully-minted App installation token gets a `404` from that same `pull/N.diff` web route on a private repo — it doesn't reliably honor App tokens the way the REST API does. `src/index.ts` fetches the diff from `GET https://api.github.com/repos/{owner}/{repo}/pulls/{number}` with `Accept: application/vnd.github.v3.diff` instead, which is the documented way to get a diff and works correctly with an App token on a private repo. If you fork the Starter Track to use App auth instead of a plain PAT, use the same endpoint — `starter/src/index.ts` already does.
- **Both tracks now fail loudly instead of silently.** Every GitHub-bound `fetch()` call checks `response.ok` and logs (`console.error` on the Advanced Track, a `502` response body on the Starter Track) instead of assuming a non-throwing `fetch()` means success — `fetch()` never throws on a 4xx/5xx, so an unchecked response used to look identical to a successful post in every log available.

This is exactly what happened deploying the reference App against a real private production repo: the App was installed correctly, permissioned correctly, and the webhook was delivered correctly — and it still never posted a single review until both of the above were fixed. See `docs/workshop-guide.md` §8 Troubleshooting #7 for the full writeup.

### 4. (Optional) Enable AI Gateway caching

By default the agent calls Workers AI directly — no gateway, no caching. To turn on the 24h diff cache, fallback routing, and observability:

1. Dashboard → **AI** → **AI Gateway** → **Create Gateway** (any name).
2. Add it to that track's `wrangler.json` (`starter/wrangler.json` or the root one):
   ```json
   "vars": { "AI_GATEWAY_NAME": "your-gateway-name" }
   ```
3. Redeploy. Every `env.AI.run()` call already checks for `AI_GATEWAY_NAME` and routes through it automatically when present — no code changes needed.

> This is opt-in on purpose: a gateway ID that doesn't exist yet returns an error, so shipping a hardcoded default would break the demo for anyone who skips this step.

---

## 📜 License
Apache-2.0. Built with ❤️ by [ClawBuilders](https://clawbuilder.club).
