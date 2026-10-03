// WhatsApp Cloud API bridge for +201065047002 (Cloudflare Worker).
//
// Routes
//   GET  /webhook   Meta verification handshake (hub.challenge)
//   POST /webhook   Incoming messages + delivery statuses from Meta
//   GET  /messages  Read stored incoming events      (Authorization: Bearer API_KEY)
//   POST /send      Send text or template message    (Authorization: Bearer API_KEY)
//   POST /read      Mark an incoming message as read (Authorization: Bearer API_KEY)
//   GET  /health    Liveness check
//
// Bindings (Settings > Variables and Secrets / Bindings)
//   WA_EVENTS        KV namespace           stores incoming events for 30 days
//   VERIFY_TOKEN     secret                 must match the token saved in Meta
//   WA_TOKEN         secret                 System User access token
//   API_KEY          secret                 protects /messages, /send, /read
//   APP_SECRET       secret (optional)      enables X-Hub-Signature-256 checks
//   FORWARD_URL      variable (optional)    also POST each webhook payload here
//   PHONE_NUMBER_ID  variable               defaults to 847705905100327
//   GRAPH_VERSION    variable               defaults to v23.0

const DEFAULT_PHONE_NUMBER_ID = "847705905100327";
const DEFAULT_GRAPH_VERSION = "v23.0";
const EVENT_TTL_SECONDS = 30 * 24 * 60 * 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname.replace(/\/+$/, "") || "/"}`;

    try {
      switch (route) {
        case "GET /webhook":
          return verifyWebhook(url, env);
        case "POST /webhook":
          return await receiveWebhook(request, env, ctx);
        case "GET /messages":
          return requireKey(request, env) ?? (await listMessages(url, env));
        case "POST /send":
          return requireKey(request, env) ?? (await sendMessage(request, env));
        case "POST /read":
          return requireKey(request, env) ?? (await markRead(request, env));
        case "GET /health":
        case "GET /":
          return json({ ok: true, phone_number_id: phoneNumberId(env) });
        default:
          return json({ error: "not_found" }, 404);
      }
    } catch (err) {
      return json({ error: "internal_error", detail: String(err?.message ?? err) }, 500);
    }
  },
};

function verifyWebhook(url, env) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && env.VERIFY_TOKEN && token === env.VERIFY_TOKEN && challenge) {
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

async function receiveWebhook(request, env, ctx) {
  const raw = await request.text();

  if (env.APP_SECRET) {
    const valid = await validSignature(raw, request.headers.get("x-hub-signature-256"), env.APP_SECRET);
    if (!valid) return new Response("Invalid signature", { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const events = flattenEvents(payload);
  ctx.waitUntil(
    Promise.all([
      ...events.map((event) =>
        env.WA_EVENTS.put(eventKey(event), JSON.stringify(event), { expirationTtl: EVENT_TTL_SECONDS })
      ),
      env.FORWARD_URL
        ? fetch(env.FORWARD_URL, { method: "POST", headers: { "content-type": "application/json" }, body: raw })
        : null,
    ])
  );

  // Meta retries anything that is not a fast 200.
  return new Response("EVENT_RECEIVED", { status: 200 });
}

// Turns Meta's nested entry/changes/value structure into flat message and status records.
function flattenEvents(payload) {
  const events = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      const metadata = value.metadata ?? {};
      const contacts = Object.fromEntries((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));

      for (const message of value.messages ?? []) {
        events.push({
          kind: "message",
          id: message.id,
          from: message.from,
          from_name: contacts[message.from] ?? null,
          type: message.type,
          text: message.text?.body ?? message.button?.text ?? message.interactive?.button_reply?.title
            ?? message.interactive?.list_reply?.title ?? message[message.type]?.caption ?? null,
          timestamp: Number(message.timestamp),
          to_phone_number_id: metadata.phone_number_id,
          raw: message,
        });
      }

      for (const status of value.statuses ?? []) {
        events.push({
          kind: "status",
          id: status.id,
          recipient: status.recipient_id,
          status: status.status,
          timestamp: Number(status.timestamp),
          errors: status.errors ?? null,
          to_phone_number_id: metadata.phone_number_id,
        });
      }

      if (!value.messages && !value.statuses) {
        events.push({ kind: change.field ?? "other", timestamp: Math.floor(Date.now() / 1000), raw: value });
      }
    }
  }
  return events;
}

function eventKey(event) {
  const ts = String(event.timestamp || Math.floor(Date.now() / 1000)).padStart(12, "0");
  return `${event.kind}:${ts}:${event.id ?? crypto.randomUUID()}`;
}

// GET /messages?kind=message|status&since=<unix seconds>&limit=50
async function listMessages(url, env) {
  const kind = url.searchParams.get("kind") ?? "message";
  const since = Number(url.searchParams.get("since") ?? 0);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);

  const keys = [];
  let cursor;
  do {
    const page = await env.WA_EVENTS.list({ prefix: `${kind}:`, cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const wanted = keys
    .filter((name) => Number(name.split(":")[1]) > since)
    .sort()
    .slice(-limit);
  const items = await Promise.all(wanted.map((name) => env.WA_EVENTS.get(name, "json")));
  return json({ count: items.length, items: items.filter(Boolean) });
}

// POST /send
//   {"to":"2010...","text":"..."}
//   {"to":"2010...","template":{"name":"...","language":"ar","components":[...]}}
//   Optional "reply_to": <incoming message id> to quote it.
async function sendMessage(request, env) {
  const body = await request.json();
  const to = String(body.to ?? "").replace(/[^\d]/g, "");
  if (!to) return json({ error: "missing_to" }, 400);

  const message = { messaging_product: "whatsapp", recipient_type: "individual", to };
  if (body.template) {
    message.type = "template";
    message.template = {
      name: body.template.name,
      language: { code: body.template.language ?? "ar" },
      ...(body.template.components ? { components: body.template.components } : {}),
    };
  } else if (body.text) {
    message.type = "text";
    message.text = { body: body.text, preview_url: Boolean(body.preview_url) };
  } else {
    return json({ error: "missing_text_or_template" }, 400);
  }
  if (body.reply_to) message.context = { message_id: body.reply_to };

  return graph(env, message);
}

// POST /read {"message_id":"wamid..."}
async function markRead(request, env) {
  const { message_id } = await request.json();
  if (!message_id) return json({ error: "missing_message_id" }, 400);
  return graph(env, { messaging_product: "whatsapp", status: "read", message_id });
}

async function graph(env, payload) {
  if (!env.WA_TOKEN) return json({ error: "WA_TOKEN not configured" }, 500);
  const version = env.GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
  const res = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId(env)}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.WA_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return json(await res.json(), res.status);
}

function phoneNumberId(env) {
  return env.PHONE_NUMBER_ID || DEFAULT_PHONE_NUMBER_ID;
}

function requireKey(request, env) {
  const header = request.headers.get("authorization") ?? "";
  if (!env.API_KEY || header !== `Bearer ${env.API_KEY}`) return json({ error: "unauthorized" }, 401);
  return null;
}

async function validSignature(raw, header, secret) {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
