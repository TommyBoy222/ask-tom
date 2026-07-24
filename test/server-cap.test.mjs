/**
 * Direct-POST server tests for the 600-character message cap.
 *
 * The whole point of the server cap is that it holds WITHOUT a browser — anyone
 * can POST straight to /api/chat and bypass the input's maxlength. These tests
 * drive the real handler with mocked network (Anthropic + Upstash Redis) so the
 * enforcement, ordering (reject before any Anthropic call and before any
 * rate-limit increment), and history-trim behavior are all proven in isolation.
 *
 * No test framework, no dependencies. Run:  node test/server-cap.test.mjs
 */

// ---- Network mock (must be installed before importing the handler) --------
const FAKE_REDIS_URL = "https://fake-redis.example.com";
process.env.UPSTASH_REDIS_REST_URL = FAKE_REDIS_URL;
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.ANTHROPIC_API_KEY = "sk-test";

let net; // reset per test
function resetNet() {
  net = { anthropic: 0, redisGet: 0, redisSet: 0, cmds: [] };
}
resetNet();

// A minimal non-streaming Anthropic success response.
function anthropicJson(reply = "Here's a short answer about Tom.") {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        content: [
          { type: "text", text: JSON.stringify({ reply, answerType: "general", suggestions: [] }) },
        ],
        usage: {},
      };
    },
    async text() {
      return "";
    },
  };
}

function redisJson(result) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { result };
    },
    async text() {
      return "";
    },
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("api.anthropic.com")) {
    net.anthropic += 1;
    return anthropicJson();
  }
  if (u.startsWith(FAKE_REDIS_URL)) {
    const cmd = JSON.parse(opts.body);
    net.cmds.push(cmd);
    if (cmd[0] === "GET") {
      net.redisGet += 1;
      return redisJson(null); // fresh bucket every time
    }
    if (cmd[0] === "SET") {
      net.redisSet += 1;
      return redisJson("OK");
    }
    return redisJson(null);
  }
  throw new Error("Unexpected fetch to " + u);
};

// ---- Fake req/res ---------------------------------------------------------
function makeReq(body) {
  return { method: "POST", headers: { "x-forwarded-for": "203.0.113.9" }, body };
}

function makeRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    chunks: [],
    _headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      if (!this.headers["content-type"]) this.headers["content-type"] = "application/json";
      this.body = obj;
      this._headersSent = true;
      return this;
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    writeHead(code, hdrs) {
      this.statusCode = code;
      this._headersSent = true;
      if (hdrs) for (const k of Object.keys(hdrs)) this.headers[k.toLowerCase()] = hdrs[k];
      return this;
    },
    write(chunk) {
      this.chunks.push(chunk);
      return true;
    },
    end(chunk) {
      if (chunk) this.chunks.push(chunk);
      return this;
    },
    get headersSent() {
      return this._headersSent;
    },
  };
}

const { default: handler } = await import("../api/chat.js");

async function call(body) {
  resetNet();
  const req = makeReq(body);
  const res = makeRes();
  await handler(req, res);
  return res;
}

const userMsg = (content) => ({ messages: [{ role: "user", content }] });
const contentType = (res) => (res.headers["content-type"] || "").toLowerCase();

// ---- Tiny assertion harness ----------------------------------------------
let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) {
    passed += 1;
    console.log("  ✓ " + label);
  } else {
    failed += 1;
    console.error("  ✗ " + label);
  }
}

// ---- Tests ----------------------------------------------------------------
console.log("Direct-POST server cap tests\n");

{
  console.log("5,000-char message, stream:false → 400, no Anthropic call, not SSE");
  const res = await call({ ...userMsg("a".repeat(5000)), stream: false });
  check("HTTP 400", res.statusCode === 400);
  check("JSON error body", res.body && typeof res.body.error === "string");
  check("maxChars echoed = 600", res.body && res.body.maxChars === 600);
  check("no Anthropic call", net.anthropic === 0);
  check("content-type is not text/event-stream", !contentType(res).includes("text/event-stream"));
}

{
  console.log("\n5,000-char message, stream:true → still 400 plain JSON, not SSE");
  const res = await call({ ...userMsg("b".repeat(5000)), stream: true });
  check("HTTP 400", res.statusCode === 400);
  check("plain JSON error body", res.body && typeof res.body.error === "string");
  check("content-type is NOT text/event-stream", !contentType(res).includes("text/event-stream"));
  check("no SSE frames written", res.chunks.length === 0);
  check("no Anthropic call", net.anthropic === 0);
}

{
  console.log("\nBoundary pair");
  const at = await call({ ...userMsg("c".repeat(600)), stream: false });
  check("exactly 600 → 200", at.statusCode === 200);
  check("exactly 600 → normal reply", at.body && typeof at.body.reply === "string" && at.body.reply.length > 0);
  check("exactly 600 → Anthropic was called", net.anthropic === 1);
  const over = await call({ ...userMsg("c".repeat(601)), stream: false });
  check("exactly 601 → 400", over.statusCode === 400);
  check("exactly 601 → no Anthropic call", net.anthropic === 0);
}

{
  console.log("\nOversized entry in history, valid new message → 200 (trim-not-reject)");
  const res = await call({
    messages: [
      { role: "user", content: "x".repeat(5000) }, // stale, oversized history
      { role: "assistant", content: "y".repeat(5000) }, // stale, oversized history
      { role: "user", content: "What does Tom do now?" }, // valid new message
    ],
    stream: false,
  });
  check("HTTP 200 (not 400)", res.statusCode === 200);
  check("normal reply returned", res.body && typeof res.body.reply === "string" && res.body.reply.length > 0);
  check("Anthropic was called", net.anthropic === 1);
}

{
  console.log("\nWhitespace edge: 600 chars of content + trailing newlines → accepted");
  const res = await call({ ...userMsg("d".repeat(600) + "\n\n\n"), stream: false });
  check("HTTP 200 (trimmed before measuring)", res.statusCode === 200);
  check("Anthropic was called", net.anthropic === 1);
}

{
  console.log("\nRate-limit budget untouched by a rejected oversized message");
  const rejected = await call({ ...userMsg("e".repeat(5000)), stream: false });
  check("oversized → 400", rejected.statusCode === 400);
  check("oversized → zero Redis SET (no counter increment)", net.redisSet === 0);
  const okRes = await call({ ...userMsg("A quick valid question?"), stream: false });
  check("following valid message → 200", okRes.statusCode === 200);
  check("valid message DID advance the counter (Redis SET)", net.redisSet > 0);
}

{
  console.log("\nExisting behavior preserved");
  const empty = await call({ messages: [], stream: false });
  check("empty messages → 400 'A user message is required'", empty.statusCode === 400 && /required/i.test(empty.body.error));
  const notUser = await call({ messages: [{ role: "assistant", content: "hi" }], stream: false });
  check("last message not from user → 400", notUser.statusCode === 400);
}

// ---- Summary --------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
