// GeoMonix intake + quote Worker
//
// Endpoints:
//
//   POST /api/intake
//     Body: { messages: [{role, content}, ...], turnstileToken? }
//     Returns: { message, done, brief }
//     Drives the intake conversation with Claude Haiku. See system-prompt.js.
//
//   POST /api/quote
//     Body: { brief: { service, summary, tags }, client: { name, email }, transcript?, turnstileToken? }
//     Returns, for SAFE services:
//       { kind: "card", quote: { priceRange, priceNotes, scopeSummary, sample, disclaimer, nextStepCta } }
//     Returns, for REVIEW services:
//       { kind: "holding", message: "...thank you, Dr Movahedifar will respond within 24h..." }
//     For review services, also emails Reza the AI-drafted quote and sends the
//     client a holding email (requires RESEND_API_KEY + FROM_EMAIL + REZA_EMAIL).

import { SYSTEM_PROMPT } from "./system-prompt.js";
import { buildQuotePrompt } from "./quote-prompt.js";
import { getRates, isSafeService } from "./service-rates.js";
import { sendEmail, buildRezaReviewEmail, buildClientHoldingEmail } from "./email.js";

const INTAKE_MODEL = "claude-haiku-4-5-20251001";
const QUOTE_MODEL = "claude-sonnet-4-6"; // higher quality for the value-delivery step
const INTAKE_MAX_TOKENS = 800;
const QUOTE_MAX_TOKENS = 2000;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 2000;
const ANTHROPIC_VERSION = "2023-06-01";

// ─────────────── CORS ───────────────

const CORS_BASE = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] || "*";
  return { ...CORS_BASE, "Access-Control-Allow-Origin": allowOrigin, Vary: "Origin" };
}

function json(body, init, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...extraHeaders, ...(init?.headers || {}) },
  });
}

// ─────────────── Turnstile ───────────────

async function verifyTurnstile(token, secret, ip) {
  if (!secret) return true; // dev mode: no secret configured → skip
  if (!token) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  if (!res.ok) return false;
  const data = await res.json();
  return data.success === true;
}

// ─────────────── Claude helper ───────────────

async function callClaude({ model, systemPrompt, messages, maxTokens, env }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system: [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ],
    messages,
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function parseJsonLoose(text) {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first > 0 || last < t.length - 1) {
    if (first !== -1 && last !== -1) t = t.slice(first, last + 1);
  }
  return JSON.parse(t);
}

// ─────────────── Validators ───────────────

function validateMessages(messages) {
  if (!Array.isArray(messages)) return "messages must be an array";
  if (messages.length === 0) return "messages must not be empty";
  if (messages.length > MAX_MESSAGES) return `too many messages (max ${MAX_MESSAGES})`;
  for (const m of messages) {
    if (!m || typeof m !== "object") return "each message must be an object";
    if (m.role !== "user" && m.role !== "assistant") return "role must be 'user' or 'assistant'";
    if (typeof m.content !== "string") return "content must be a string";
    if (m.content.length > MAX_MESSAGE_CHARS) return `message too long (max ${MAX_MESSAGE_CHARS} chars)`;
  }
  if (messages[messages.length - 1].role !== "user") return "last message must be from user";
  return null;
}

function validateQuoteBody(body) {
  if (!body || typeof body !== "object") return "invalid body";
  const { brief, client } = body;
  if (!brief || typeof brief !== "object") return "brief required";
  if (typeof brief.service !== "string") return "brief.service required";
  if (typeof brief.summary !== "string" || brief.summary.length < 10) return "brief.summary required";
  if (brief.summary.length > 4000) return "brief.summary too long";
  if (!client || typeof client !== "object") return "client required";
  if (typeof client.name !== "string" || client.name.trim().length < 2) return "client.name required";
  if (typeof client.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(client.email)) return "client.email invalid";
  return null;
}

// ─────────────── Handlers ───────────────

async function handleIntake(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, { status: 400 }, corsHeaders(request, env)); }

  const { messages, turnstileToken } = body || {};
  const err = validateMessages(messages);
  if (err) return json({ error: err }, { status: 400 }, corsHeaders(request, env));

  const isFirstTurn = !messages.some((m) => m.role === "assistant");
  if (isFirstTurn) {
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const ok = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET, ip);
    if (!ok) return json({ error: "turnstile verification failed" }, { status: 403 }, corsHeaders(request, env));
  }

  let assistantText;
  try {
    assistantText = await callClaude({
      model: INTAKE_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      messages,
      maxTokens: INTAKE_MAX_TOKENS,
      env,
    });
  } catch (e) {
    return json({ error: "upstream error", detail: String(e.message || e) }, { status: 502 }, corsHeaders(request, env));
  }

  let parsed;
  try {
    parsed = parseJsonLoose(assistantText);
    if (typeof parsed.message !== "string") throw new Error("missing 'message'");
    if (typeof parsed.done !== "boolean") throw new Error("missing 'done'");
  } catch {
    return json({ message: assistantText, done: false, brief: null, warn: "non-JSON reply" }, { status: 200 }, corsHeaders(request, env));
  }
  return json(parsed, { status: 200 }, corsHeaders(request, env));
}

async function handleQuote(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, { status: 400 }, corsHeaders(request, env)); }

  const err = validateQuoteBody(body);
  if (err) return json({ error: err }, { status: 400 }, corsHeaders(request, env));

  // Turnstile on quote requests too — this endpoint is the expensive one.
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ok = await verifyTurnstile(body.turnstileToken, env.TURNSTILE_SECRET, ip);
  if (!ok) return json({ error: "turnstile verification failed" }, { status: 403 }, corsHeaders(request, env));

  const { brief, client, transcript = "" } = body;
  const service = brief.service;
  const rates = getRates(service);
  const safe = isSafeService(service);
  const mode = safe ? "safe" : "review";

  // Build the Stage 2 prompt and pass the brief as a "user" message.
  const quoteSystemPrompt = buildQuotePrompt(service, mode);
  const userPrompt =
    `## Client brief\n${brief.summary}\n\n` +
    (brief.tags && brief.tags.length ? `## Tags\n${brief.tags.join(", ")}\n\n` : "") +
    `## Client contact (for internal reference only)\n${client.name} <${client.email}>\n\n` +
    `Produce the quote JSON now.`;

  let draftText;
  try {
    draftText = await callClaude({
      model: QUOTE_MODEL,
      systemPrompt: quoteSystemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: QUOTE_MAX_TOKENS,
      env,
    });
  } catch (e) {
    return json({ error: "upstream error", detail: String(e.message || e) }, { status: 502 }, corsHeaders(request, env));
  }

  let draft;
  try {
    draft = parseJsonLoose(draftText);
  } catch {
    return json({ error: "quote parser failed", raw: draftText }, { status: 502 }, corsHeaders(request, env));
  }

  if (safe) {
    // Fast path: return the quote card directly to the chat.
    return json(
      { kind: "card", service, serviceLabel: rates.label, quote: draft },
      { status: 200 },
      corsHeaders(request, env)
    );
  }

  // Review path: email Reza and send holding email to client.
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL || !env.REZA_EMAIL) {
    return json(
      {
        error: "email not configured",
        detail: "RESEND_API_KEY / FROM_EMAIL / REZA_EMAIL must be set for review-category quotes",
      },
      { status: 500 },
      corsHeaders(request, env)
    );
  }

  const rezaMail = buildRezaReviewEmail({
    service,
    serviceLabel: rates.label,
    client,
    brief,
    draft,
    chatTranscript: transcript || "(not provided)",
  });

  const clientMail = buildClientHoldingEmail({ client, serviceLabel: rates.label, brief });

  // Send both in parallel; if either fails, surface a helpful error.
  try {
    await Promise.all([
      sendEmail({
        apiKey: env.RESEND_API_KEY,
        from: env.FROM_EMAIL,
        to: env.REZA_EMAIL,
        replyTo: client.email,
        subject: rezaMail.subject,
        text: rezaMail.text,
      }),
      sendEmail({
        apiKey: env.RESEND_API_KEY,
        from: env.FROM_EMAIL,
        to: client.email,
        replyTo: env.REZA_EMAIL,
        subject: clientMail.subject,
        text: clientMail.text,
      }),
    ]);
  } catch (e) {
    return json(
      { error: "email send failed", detail: String(e.message || e) },
      { status: 502 },
      corsHeaders(request, env)
    );
  }

  return json(
    {
      kind: "holding",
      service,
      serviceLabel: rates.label,
      message:
        "Thank you. Dr Movahedifar personally reviews every quote for this kind of work. " +
        "You'll receive an indicative quote, scope summary, and a preview of the approach by email within 24 hours. " +
        "A copy of your brief has been sent to the email address you provided.",
    },
    { status: 200 },
    corsHeaders(request, env)
  );
}

// ─────────────── Router ───────────────

export default {
  async fetch(request, env /*, ctx */) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (url.pathname === "/api/intake" && request.method === "POST") {
      return handleIntake(request, env);
    }
    if (url.pathname === "/api/quote" && request.method === "POST") {
      return handleQuote(request, env);
    }
    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, { status: 405 }, corsHeaders(request, env));
    }
    return json({ error: "not found" }, { status: 404 }, corsHeaders(request, env));
  },
};
