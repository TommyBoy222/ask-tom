# ask-tom

An AI career assistant, linked from my LinkedIn Featured section, that answers visitor questions about my background, experience, and projects — built to demonstrate the same systems thinking I bring to customer support operations, applied to a public-facing AI product.

**Live:** the chat is linked from my [LinkedIn profile](https://www.linkedin.com/) → Featured section.

---

## Why this exists

Instead of a static resume, visitors get a conversation. The bot answers questions about my work history, skills, and the AI projects I've built (like Jarvis, an internal RAG-based Slack assistant) — and redirects anything out of scope to a direct conversation with me.

It also serves as its own proof point: a self-taught, end-to-end AI product — prompt design, backend, rate limiting, cost controls, and failure handling — shipped by someone whose day job is operations leadership, not software engineering.

## Architecture

```
Visitor (mobile-first web UI)
        │
        ▼
index.html  ── fetch ──►  /api/chat  (Vercel serverless function, Node runtime)
                              │
                              ├──►  Upstash Redis (REST) — per-IP rate-limit state
                              │
                              └──►  Anthropic API (Claude Haiku) — response generation
```

One Vercel project serves both the static frontend and the API route on the same domain — no CORS, one deploy, one URL.

**Key components:**

- **`index.html`** — the entire frontend: chat UI, LinkedIn-inspired styling, auto dark/light mode, animated typing indicator, per-message timestamps, chat-transcript download. No framework, no build step.
- **`api/chat.js`** — the backend: holds the system prompt (the bot's entire knowledge base), enforces rate limits, calls Claude, and shapes every failure into a friendly response.

## Design decisions

**Prompt boundaries as a whitelist, not a blocklist.** The system prompt only permits discussion of what's explicitly documented — anything else (compensation, coworkers, self-assessments, off-topic questions) gets a polite redirect to contact me directly. Blocklists fail open; whitelists fail closed.

**Rate limiting anchored to the last *successful* message.** 1 message / 10 seconds and 15 / rolling hour, per IP. Blocked attempts never reset or extend the timers — retrying doesn't push your window out. First blocked attempt explains the limit; every retry after gets a live countdown ("Stretching my legs, be back in 4 seconds") recalculated in real time.

**Graceful degradation everywhere.**
- Redis not configured? Rate limiting silently disables; the bot still works (the spending cap remains the backstop).
- Anthropic API down or spending cap hit? Visitors see a friendly capacity message, never a raw error.
- Model tries to overrun its token budget? The prompt instructs it to finish on a complete thought and offer to continue.

**Layered cost controls.** Public AI endpoints are abuse magnets. Defense in depth: per-IP rate limits (first line) → cheap model with a token cap per response (second) → hard monthly spending cap at the provider (final backstop). Any one layer failing doesn't take the system down.

**Model-agnostic conversation state.** The frontend keeps conversation history in memory and excludes rate-limit warnings and outage notices from the context sent to the model — system chatter never pollutes the conversation the model reasons over.

**Built for evolution.** The API response shape and UI are structured so planned features (contextual follow-up suggestions after each answer, a resource menu) slot in without rewriting the frontend — the interface between static and AI-generated suggestions is the same.

## The migration story

This originally shipped on Cloudflare Workers. Every API call failed with an opaque `403 "Request not allowed"` — while identical requests from a laptop succeeded. Root cause: Anthropic's API sits behind Cloudflare's own WAF, which can block requests originating *from* Cloudflare Workers (a known Cloudflare-to-Cloudflare conflict).

Rather than fight infrastructure I don't control, I migrated the backend to Vercel's Node runtime (AWS under the hood), ported the KV-based rate limiter to Upstash Redis, and simplified the architecture in the process — frontend and backend now share one domain, eliminating CORS entirely. Diagnosis path: live log tailing → direct API testing to isolate the key → error-body capture to expose the real failure → platform research to confirm the root cause.

## Stack

- **Frontend:** vanilla HTML/CSS/JS, mobile-first, system dark/light mode
- **Backend:** Vercel serverless function (Node)
- **Model:** Claude Haiku (Anthropic API), 450-token response cap
- **Rate limiting:** Upstash Redis (REST), per-IP, graceful fallback
- **Hosting:** Vercel (single project: static + API)

## Running your own

1. Fork/clone, then set your own content in the `SYSTEM_PROMPT` in `api/chat.js`
2. Update `LINKEDIN_URL` (and optionally add a `resume.pdf`) in `index.html`
3. `npx vercel login && npx vercel link`
4. `npx vercel env add ANTHROPIC_API_KEY` (get one at console.anthropic.com — set a spending cap first)
5. Optional rate limiting: add Upstash for Redis via Vercel's Storage tab (env vars auto-injected)
6. `npx vercel --prod`

**Never commit secrets.** The API key lives only as a Vercel environment variable; `.env*` and `.vercel/` are gitignored.

---

*Built by Tom Greene — operations leader, self-taught AI builder. This repo is the public companion to the live assistant; it evolves as the assistant does.*
