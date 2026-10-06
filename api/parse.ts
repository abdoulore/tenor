/**
 * Intent parsing, server side.
 *
 * The key lives here and not in the browser. Anything Vite inlines with a VITE_ prefix ends
 * up readable in the deployed bundle, so shipping the key that way would publish it to
 * every visitor. This endpoint holds it in a Vercel environment variable instead and the
 * page calls this.
 *
 * The model parses and explains. It never produces a number that reaches a user: the cost
 * engine is deterministic and runs in the browser on live order books.
 */

const MAX_TEXT = 500;
const MAX_TICKERS = 250;

const INTENT_TOOL = {
  name: "intent",
  description: "The parsed trading intent.",
  input_schema: {
    type: "object",
    properties: {
      ticker: { type: "string", description: "US stock ticker, uppercase" },
      notionalUsd: { type: "number", description: "Position size in US dollars" },
      direction: { type: "string", enum: ["long", "short"] },
      horizonDays: { type: "number", description: "Holding period in days" },
      leverage: { type: "number" },
      wantsDividends: { type: "boolean" },
      wantsVoting: { type: "boolean" },
      usesAsCollateral: { type: "boolean" },
      needsOffHoursExit: { type: "boolean" },
      found: {
        type: "array",
        items: { type: "string" },
        description:
          "Only the fields the text actually states. Omit anything you inferred or defaulted, " +
          "because the caller discards values that are not listed here.",
      },
    },
    required: ["ticker", "notionalUsd", "direction", "horizonDays", "found"],
  },
};

/**
 * Classic Node signature rather than the Web one. Vercel supports both, but this project
 * sets an explicit buildCommand and outputDirectory, which put the deployment on the static
 * path and built no functions at all until this was declared in vercel.json. The plainest
 * signature is the one least likely to be skipped again.
 */
/*
 * Who may call this, and how often.
 *
 * The endpoint spends money on every call, and it was reachable from any origin with no
 * limit. Two layers, and neither is a substitute for a spend cap on the Anthropic account:
 *
 *   Origin   only the site itself. This stops other web pages from using it, not a script,
 *            since a script can send any Origin header it likes.
 *   Rate     per address, per warm instance. Serverless instances are short lived and not
 *            shared, so this bounds a burst rather than a determined caller.
 *
 * The page falls back to its rules parser on any refusal, so a legitimate visitor who trips
 * either one still gets a working product.
 */
/*
 * The model behind this function. Qwen 3.8 Max through Bitget's hackathon endpoint, which speaks
 * the OpenAI chat format, when QWEN_API_KEY is set; otherwise Claude through Anthropic's API.
 * Either way the caller gets back one tool call: its name and its arguments.
 */
const QWEN_URL = "https://hackathon.bitgetops.com/v1/chat/completions";
const QWEN_MODEL = "qwen3.8-max";
const CLAUDE_MODEL = "claude-sonnet-5";

type ToolSpec = { name: string; description: string; input_schema: Record<string, unknown> };
type Msg = { role: "user" | "assistant"; content: string };
class Upstream extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) { super(`upstream ${status}`); this.status = status; this.detail = detail; }
}

const modelConfigured = () => Boolean(process.env.QWEN_API_KEY || process.env.ANTHROPIC_API_KEY);

async function callModel(o: { system?: string; messages: Msg[]; tools: ToolSpec[]; force?: string; maxTokens: number }):
  Promise<{ name: string; input: Record<string, unknown>; model: string; text?: string } | null> {
  const qwen = process.env.QWEN_API_KEY;
  if (qwen) {
    const send = (toolChoice: unknown) => fetch(QWEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${qwen}` },
      body: JSON.stringify({
        model: QWEN_MODEL,
        max_tokens: o.maxTokens,
        messages: [...(o.system ? [{ role: "system", content: o.system }] : []), ...o.messages],
        tools: o.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        tool_choice: toolChoice,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    let r = await send(o.force ? { type: "function", function: { name: o.force } } : "required");
    // Some OpenAI-compatible servers accept only "auto"; the prompt still asks for a tool.
    if (r.status === 400) r = await send("auto");
    if (!r.ok) throw new Upstream(r.status, (await r.text().catch(() => "")).slice(0, 200));
    const j = await r.json();
    const msg = j?.choices?.[0]?.message;
    const call = msg?.tool_calls?.[0]?.function;
    if (call?.name) {
      let input: Record<string, unknown> = {};
      try { input = typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments ?? {}; } catch { return null; }
      return { name: call.name, input, model: QWEN_MODEL };
    }
    return typeof msg?.content === "string" && msg.content.trim() ? { name: "", input: {}, model: QWEN_MODEL, text: msg.content.trim() } : null;
  }

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: o.maxTokens,
      ...(o.system ? { system: o.system } : {}),
      tools: o.tools,
      tool_choice: o.force ? { type: "tool", name: o.force } : { type: "any" },
      messages: o.messages,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Upstream(r.status, (await r.text().catch(() => "")).slice(0, 200));
  const out = await r.json();
  const use = out?.content?.find?.((c: { type: string }) => c.type === "tool_use");
  return use ? { name: use.name, input: use.input ?? {}, model: CLAUDE_MODEL } : null;
}

const ALLOWED_ORIGINS = new Set([
  "https://tenor-desk.vercel.app",
  "https://tenor-nu-blush.vercel.app",
  "http://localhost:5173",
  "http://localhost:4173",
]);
const WINDOW_MS = 60_000;
const PER_ADDRESS = 12;
const PER_INSTANCE = 120;
const hits = new Map<string, number[]>();
let instanceHits: number[] = [];

function allowOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Preview deployments of this project only.
  return /^https:\/\/tenor-[a-z0-9]+-oreapps\.vercel\.app$/.test(origin);
}

function underLimit(address: string, now: number): boolean {
  instanceHits = instanceHits.filter((t) => now - t < WINDOW_MS);
  if (instanceHits.length >= PER_INSTANCE) return false;
  const mine = (hits.get(address) ?? []).filter((t) => now - t < WINDOW_MS);
  if (mine.length >= PER_ADDRESS) { hits.set(address, mine); return false; }
  mine.push(now);
  hits.set(address, mine);
  instanceHits.push(now);
  if (hits.size > 5_000) hits.clear(); // never let the table grow without bound
  return true;
}

export default async function handler(
  req: { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> },
  res: {
    status: (code: number) => typeof res;
    json: (body: unknown) => void;
    setHeader: (k: string, v: string) => void;
  },
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const header = (name: string): string | undefined => {
    const v = req.headers?.[name];
    return Array.isArray(v) ? v[0] : v;
  };
  if (!allowOrigin(header("origin"))) {
    res.status(403).json({ error: "origin not allowed" });
    return;
  }
  const address = (header("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (!underLimit(address, Date.now())) {
    res.status(429).json({ error: "too many requests" });
    return;
  }

  // Not an error worth shouting about: the page falls back to its rules parser and works.
  if (!modelConfigured()) {
    res.status(503).json({ error: "parser_unconfigured" });
    return;
  }

  const body = (typeof req.body === "string" ? safeParse(req.body) : req.body) as
    { text?: string; tickers?: string[] } | null;

  const text = String(body?.text ?? "").slice(0, MAX_TEXT).trim();
  if (!text) {
    res.status(400).json({ error: "no text" });
    return;
  }
  const tickers = Array.isArray(body?.tickers) ? body!.tickers!.slice(0, MAX_TICKERS).map(String) : [];

  try {
    const out = await callModel({
      messages: [{
        role: "user",
        content:
          `Parse this into a trading intent with the intent tool. Only report fields the text actually states in "found".
` +
          `Known tickers: ${tickers.join(" ")}

${text}`,
      }],
      tools: [INTENT_TOOL],
      force: "intent",
      maxTokens: 512,
    });
    if (out?.name !== "intent") {
      res.status(502).json({ error: "no structured output" });
      return;
    }
    res.status(200).json({ input: out.input, model: out.model });
  } catch (e) {
    if (e instanceof Upstream) res.status(502).json({ error: "upstream", status: e.status, detail: e.detail });
    else res.status(502).json({ error: "request failed", detail: String((e as Error)?.message ?? e).slice(0, 200) });
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
