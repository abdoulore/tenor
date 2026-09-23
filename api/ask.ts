/**
 * Questions about a result, answered from the engine's own numbers.
 *
 * The page sends the fact sheet it built from the engine's result, and either a question or
 * nothing (nothing means "explain this"). The model does one of two things: answers in words,
 * using only figures on the sheet, or asks for the result to be priced again with something
 * changed, such as a longer holding period or a different amount. It never works a number out.
 *
 * This function does not have to be trusted to keep to that. The page checks every answer
 * against the sheet before showing it (engine/grounding.ts) and withholds any answer with a
 * figure the engine did not produce.
 *
 * Same origin check and rate limit as the parser, because every call here costs money too.
 */

const MODEL = "claude-sonnet-5";
const MAX_FACTS = 5_000;
const MAX_QUESTION = 300;
const MAX_TURNS = 3;
const WINDOW_MS = 60_000;
const PER_ADDRESS = 20;
const PER_INSTANCE = 200;
const hits = new Map<string, number[]>();
let instanceHits: number[] = [];

const ALLOWED_ORIGINS = new Set([
  "https://tenor-desk.vercel.app",
  "https://tenor-nu-blush.vercel.app",
  "http://localhost:5173",
  "http://localhost:4173",
]);

function allowOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
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
  if (hits.size > 5_000) hits.clear();
  return true;
}

const TOOLS = [
  {
    name: "answer",
    description: "Answer the reader in words, using only figures that appear on the fact sheet.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "Two or three short sentences." } },
      required: ["text"],
    },
  },
  {
    name: "reprice",
    description:
      "Price the result again with something changed. Use this whenever the question needs a figure " +
      "that is not on the sheet and would come from a different company, amount, holding period, " +
      "direction or leverage. Include only what changes.",
    input_schema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "US stock ticker, uppercase" },
        notionalUsd: { type: "number", description: "Amount in US dollars" },
        horizonDays: { type: "number", description: "Holding period in days. A month is 30, three months 90, a year 365." },
        direction: { type: "string", enum: ["long", "short"] },
        leverage: { type: "number" },
      },
    },
  },
];

const RULES = `You explain one result from Tenor. Tenor compares what it costs to hold a US stock on Bitget as a tokenized stock or as a perpetual future, using live Bitget prices. The fact sheet below is everything Tenor worked out for this result.

Rules:
1. Every number you write must appear on the fact sheet, written as it appears there. Dollar amounts keep their cents. Never add, subtract, multiply, convert, round up a range or estimate. If a figure is not on the sheet, do not write it.
2. If the question needs a figure that pricing again with a different company, amount, holding period, direction or leverage would produce, call reprice with only what changes. Do not guess what it would show.
3. For questions about the time of day, use the session hours and the lines on typical spread and slippage by time of day. Match the reader's hour to a session using the hours on the sheet.
4. If neither the sheet nor a reprice can answer it, say in one sentence that Tenor has not worked that out. Never mention the fact sheet to the reader; to them it is Tenor's numbers.
5. Never say whether to buy or sell a stock. Tenor compares costs. It does not pick stocks.
6. Two or three short sentences. Plain English and standard trading terms. No lists, headings, markdown or dashes used as punctuation.`;

const EXPLAIN =
  "Explain this result to the reader in two or three sentences: which way is cheaper and by how much, " +
  "and what decides it. Then, only if one applies, the single most useful extra point, in this order " +
  "of priority: a split that saves money, the tokenized stock or the perpetual being unpriceable at " +
  "this amount, a dividend or earnings report " +
  "inside the holding period, a time of day that is usually cheaper. Do not mention anything that " +
  "falls after the holding period, do not mention Stock+, which is never priced, and do not say " +
  "that something does not apply.";

type Turn = { q: string; a: string };

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
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(503).json({ error: "unconfigured" });
    return;
  }

  const body = (typeof req.body === "string" ? safeParse(req.body) : req.body) as
    { facts?: string; question?: string; history?: Turn[]; rejected?: string[] } | null;
  const facts = String(body?.facts ?? "").slice(0, MAX_FACTS).trim();
  if (!facts) {
    res.status(400).json({ error: "no facts" });
    return;
  }
  const question = String(body?.question ?? "").slice(0, MAX_QUESTION).trim();
  const history = (Array.isArray(body?.history) ? body!.history! : [])
    .slice(-MAX_TURNS)
    .map((t) => ({ q: String(t?.q ?? "").slice(0, MAX_QUESTION), a: String(t?.a ?? "").slice(0, 600) }))
    .filter((t) => t.q && t.a);
  const rejected = (Array.isArray(body?.rejected) ? body!.rejected! : []).slice(0, 12).map(String);

  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const t of history) {
    messages.push({ role: "user", content: t.q }, { role: "assistant", content: t.a });
  }
  let ask = question || EXPLAIN;
  if (rejected.length) {
    ask += `\n\nYour previous answer used ${rejected.join(", ")}, which ${rejected.length === 1 ? "is" : "are"} not on the fact sheet. ` +
      "Answer again using only figures that are on the sheet, or no figures at all.";
  }
  messages.push({ role: "user", content: ask });

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: `${RULES}\n\nFact sheet:\n${facts}`,
        tools: TOOLS,
        tool_choice: { type: "any" },
        messages,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      res.status(502).json({ error: "upstream", status: upstream.status, detail: detail.slice(0, 200) });
      return;
    }
    const out = await upstream.json();
    const use = out?.content?.find?.((c: { type: string }) => c.type === "tool_use");
    if (use?.name === "answer" && typeof use.input?.text === "string") {
      res.status(200).json({ kind: "answer", text: use.input.text, model: MODEL });
      return;
    }
    if (use?.name === "reprice" && use.input && typeof use.input === "object") {
      res.status(200).json({ kind: "reprice", changes: use.input, model: MODEL });
      return;
    }
    res.status(502).json({ error: "no structured output" });
  } catch (e) {
    res.status(502).json({ error: "request failed", detail: String((e as Error)?.message ?? e).slice(0, 200) });
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
