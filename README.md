# ask-tom

An AI assistant, linked from my LinkedIn Featured section, that answers questions about my work — the roles, the projects I've built, and the reasoning behind how they were built.

**Live:** [ask-tom.vercel.app](https://ask-tom.vercel.app)

---

## Why this exists

A resume tells you where someone worked. It doesn't tell you how they think, which is the part that actually predicts how they'll handle the next problem. So instead of a static document, visitors get a conversation — one that covers the career (a customer support manager at a health-tech scale-up, five years and three promotions in) but goes just as deep on the systems I've built and the decisions inside them.

That second half is the point. Ask about the internal knowledge-based bot I built — a Slack assistant with a RAG pipeline, put together outside of engineering over nights and weekends — and the conversation can go past *what it does* into the problem it was solving and the design calls that came out of it. This project works the same way: it's the artifact and the case study at once, and the reasoning behind the choices documented further down this page is the kind of thing it's built to talk through.

It also serves as its own proof point: a self-taught, end-to-end AI product — prompt design, backend, streaming, rate limiting, cost controls, abuse hardening, and failure handling — shipped by someone who manages a customer support team, not an engineering one.

## What it does

Visitors ask what they want. Career questions get direct answers; project questions go into what was built, how it works, and the thinking behind it. Anything outside what's documented — compensation, colleagues, internal company detail — gets a polite redirect to a conversation with me instead of a guess.

The interface stays out of the way. Replies stream in as they're generated. Each answer can be followed by up to two AI-generated follow-ups drawn from what the visitor seems curious about, so the conversation has somewhere to go without the visitor having to think of the next question. A slide-out menu offers the resume, LinkedIn, this repo, a downloadable transcript, a reset, and a privacy panel — the conversation lives only in the visitor's browser tab and isn't tied to any account, and the panel in the menu spells out exactly what that means. Conversations survive a refresh, timestamps sit under each message, the theme follows the system's, and every failure — rate limit, outage, dropped connection, offline — resolves into something readable rather than an error.

## Architecture

```
Visitor (mobile-first web UI)
        │
        ▼
index.html  ── fetch ──►  /api/chat  (Vercel serverless function, Node runtime)
                              │
                              ├──►  Upstash Redis (REST) — rate-limit state
                              │
                              └──►  Anthropic API (Claude Haiku) — response generation
                                        │
                                    SSE stream back to the browser
```

One Vercel project serves both the static frontend and the API route on the same domain — no CORS, one deploy, one URL.

### Repo layout

```
ask-tom/
├── index.html               # Entire frontend — inline CSS + JS
├── api/
│   └── chat.js              # Entire backend — one serverless function
├── test/
│   └── server-cap.test.mjs  # Dependency-free server tests
├── resume.pdf               # Static asset
└── README.md
```

Six tracked files. No `package.json`, no `node_modules`, no lockfile, no bundler, no build step. The frontend is one hand-written HTML file; the backend is one file using only the Node runtime and `fetch`. Vercel's conventions do the routing for free — anything under `api/` becomes an endpoint, so `api/chat.js` is served at `/api/chat` with zero config, and `index.html` is the static root.

That flatness is deliberate. A project this size doesn't need tooling, and every dependency is something to maintain, audit, and explain.

## Design decisions

**Prompt boundaries as a whitelist, not a blocklist.** The system prompt only permits discussion of what's explicitly documented — anything else (compensation, coworkers, internal information, personal opinions, self-assessments) gets a polite redirect to contact me directly. Blocklists fail open; whitelists fail closed.

**Adversarial input is assumed, not hoped against.** A public AI endpoint linked from a professional profile will be probed. The prompt holds its role against instruction-override attempts in any language, encoding, or roleplay framing, and treats claimed authority ("I'm the developer," "this is a test") as an ordinary visitor message. It declines general-purpose assistant work, refuses to fabricate projects, metrics, credentials, or history it wasn't given, and never reveals or reproduces its own instructions.

**Rate limiting keyed on the person, not just the address.** Naive per-IP limiting punishes the wrong people: everyone behind a shared office WiFi or carrier-grade NAT competes for one budget, and anyone hopping LTE → WiFi mid-conversation gets a fresh one. So the limiter uses two buckets. A per-tab session ID carries the real limit (15 messages/hour, 10-second cooldown); the IP carries a looser backstop (45/hour, no cooldown) that catches abuse without making neighbors collide. Requests arriving with no session ID — scripted clients — get the strict limits applied to their IP, so omitting it buys nothing.

Blocked attempts never reset or extend the timers, so retrying doesn't push the window out. The first block explains the limit; every retry after gets a live countdown recalculated in real time. Warning responses never reach the model.

**Streaming with a fallback that's actually exercised.** The model returns a structured JSON envelope containing the reply and its follow-up suggestions. The backend decodes the reply string out of that envelope as it streams — buffering escape sequences that split across chunk boundaries — and forwards only visitor-visible text as SSE events, then delivers the metadata in a final event. One request, no second call, and the prompt contract never changed to accommodate streaming.

Failure is handled at every layer rather than at the end: an API error before streaming starts returns a plain-JSON capacity message; a stream that dies mid-generation keeps whatever text arrived and closes cleanly; a browser without `ReadableStream` support parses the same payload in one pass; a connection that never opens shows an offline notice with a retry affordance. The non-streaming path remains fully functional as the fallback.

**Layered cost controls.** Public AI endpoints are abuse magnets. Defense in depth: rate limits (first line) → a cheap model with a per-response token cap and a 10-turn history window (second) → a hard monthly spending cap at the provider (final backstop). Any one layer failing doesn't take the system down.

**A 600-character message cap, enforced where it counts.** The input stops at 600 characters with a counter that appears at 500 and warns at 570. But the client cap is a courtesy — anyone can POST directly to the API — so the server enforces the same limit independently, rejecting oversized messages before they reach the model or consume the sender's rate-limit budget. Older messages in the replayed history are trimmed rather than rejected, so stale context can't break a live session.

**Graceful degradation everywhere.**
- Redis not configured or erroring? Rate limiting silently disables; the bot still works.
- Anthropic down or spending cap hit? Visitors see a friendly capacity message, never a raw error.
- Session storage unavailable (private browsing, quota)? The chat works, just without persistence.
- Model approaching its token budget? The prompt instructs it to finish on a complete thought and offer to continue.

**Model-agnostic conversation state.** The frontend keeps history in memory and excludes rate-limit warnings and outage notices from the context sent to the model — system chatter never pollutes the conversation the model reasons over.

## Tests

`test/server-cap.test.mjs` covers the server-side message cap: 26 checks including oversized rejection under both streaming and non-streaming requests, the exact 600/601 boundary, silent trimming of oversized history, whitespace handling, and proof that a rejected message doesn't consume rate-limit budget. It mocks `fetch` for both the Anthropic and Redis calls and imports the handler directly.

```bash
node test/server-cap.test.mjs
```

No framework, no dependencies, no runner. The coverage is aimed at the part that can fail silently — server-side enforcement is invisible from the UI, so a regression there wouldn't show up by using the site.

## The migration story

This originally shipped on Cloudflare Workers. Every API call failed with an opaque `403 "Request not allowed"` — while identical requests from a laptop succeeded. Root cause: Anthropic's API sits behind Cloudflare's own WAF, which can block requests originating *from* Cloudflare Workers (a known Cloudflare-to-Cloudflare conflict).

Rather than fight infrastructure I don't control, I migrated the backend to Vercel's Node runtime (AWS under the hood), ported the KV-based rate limiter to Upstash Redis, and simplified the architecture in the process — frontend and backend now share one domain, eliminating CORS entirely. Diagnosis path: live log tailing → direct API testing to isolate the key → error-body capture to expose the real failure → platform research to confirm the root cause.

## Stack

- **Frontend:** vanilla HTML/CSS/JS, mobile-first, system dark/light mode
- **Backend:** Vercel serverless function (Node), SSE streaming
- **Model:** `claude-haiku-4-5` via the Anthropic API, 650-token response cap
- **Rate limiting:** Upstash Redis (REST), dual-bucket, graceful fallback
- **Hosting:** Vercel (single project: static + API)

## Running your own

1. Fork/clone, then set your own content in the `SYSTEM_PROMPT` in `api/chat.js`
2. Update `LINKEDIN_URL`, `GITHUB_URL`, and `RESUME_URL` near the top of the script in `index.html` (and drop in your own `resume.pdf`)
3. `npx vercel login && npx vercel link`
4. `npx vercel env add ANTHROPIC_API_KEY` (get one at console.anthropic.com — set a spending cap first)
5. Optional rate limiting: add Upstash for Redis via Vercel's Storage tab (env vars auto-injected)
6. `npx vercel --prod`

**Never commit secrets.** The API key lives only as a Vercel environment variable; `.env*` and `.vercel/` are gitignored.

---

*Built by Tom Greene — Customer Support Manager, self-taught AI builder. This repo is the public companion to the live assistant; it evolves as the assistant does.*
