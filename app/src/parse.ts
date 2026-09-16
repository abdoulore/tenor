/**
 * Intent parsing: natural language to the constraint object.
 *
 * This is deliberately the least interesting part of the product. The model parses and
 * explains, it never touches a number that reaches a user. Everything downstream is
 * deterministic.
 *
 * Two implementations behind one interface. The deterministic parser always works and needs
 * no key. The model parser slots in when an API key exists and falls back on any failure,
 * so the surface never depends on it being there.
 */

import { DEFAULT_CONSTRAINTS, type Intent } from "../../engine/types.ts";

export interface ParseResult {
  intent: Intent;
  /** Which fields the parser actually found, so the UI can show what it inferred. */
  found: string[];
  /** Fields left at their default because nothing in the text mentioned them. */
  assumed: string[];
  parser: "deterministic" | "model";
  note?: string;
}

export interface IntentParser {
  name: string;
  available: boolean;
  parse(text: string, knownTickers: string[]): Promise<ParseResult>;
}

const MULTIPLIERS: Record<string, number> = { k: 1e3, m: 1e6 };

/** "$2,000", "2k", "10 grand", "5000 dollars" */
export function parseNotional(text: string): number | null {
  const m = text.match(/\$?\s*([\d][\d,]*(?:\.\d+)?)\s*(k|m)?\b/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const mult = m[2] ? MULTIPLIERS[m[2].toLowerCase()] : 1;
  const v = n * mult;
  // A bare small number is far more likely a horizon or a leverage than a position size.
  return v >= 100 ? v : null;
}

/** "for a month", "3 weeks", "30 days", "overnight", "a year" */
export function parseHorizonDays(text: string): number | null {
  const t = text.toLowerCase();
  if (/\bovernight\b/.test(t)) return 1;
  if (/\bintraday\b|\bday trade\b/.test(t)) return 1;
  const m = t.match(/\b(?:for\s+)?(?:(a|an|one|\d+(?:\.\d+)?)\s*)?(day|week|month|quarter|year)s?\b/);
  if (m) {
    const raw = m[1];
    const n = !raw || /^(a|an|one)$/.test(raw) ? 1 : Number(raw);
    const unit = m[2];
    const days = unit === "day" ? 1 : unit === "week" ? 7 : unit === "month" ? 30 : unit === "quarter" ? 91 : 365;
    if (Number.isFinite(n)) return Math.round(n * days);
  }
  const d = t.match(/\b(\d+)\s*d\b/);
  if (d) return Number(d[1]);
  return null;
}

export function parseLeverage(text: string): number | null {
  const m = text.match(/\b(\d+(?:\.\d+)?)\s*x\b/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  if (/\bno leverage\b|\bunlevered\b|\bspot only\b/i.test(text)) return 1;
  return null;
}

export function parseTicker(text: string, known: string[]): string | null {
  const upper = text.toUpperCase();
  // Longest first, so NVDA is not shadowed by a shorter symbol that happens to be a substring.
  const sorted = [...known].sort((a, b) => b.length - a.length);
  for (const t of sorted) {
    if (new RegExp(`\\b${t}\\b`).test(upper)) return t;
  }
  return null;
}

/**
 * The deterministic parser. No network, no key, no model.
 *
 * It reports what it found and what it assumed rather than silently defaulting, because the
 * user has to be able to correct it, and a wrong assumption shown is harmless while a wrong
 * assumption hidden is not.
 */
export const deterministicParser: IntentParser = {
  name: "deterministic",
  available: true,
  async parse(text, knownTickers) {
    const found: string[] = [];
    const assumed: string[] = [];
    const c = { ...DEFAULT_CONSTRAINTS };

    const ticker = parseTicker(text, knownTickers);
    if (ticker) found.push("ticker");

    const notionalUsd = parseNotional(text);
    if (notionalUsd !== null) found.push("size"); else assumed.push("size");

    const horizonDays = parseHorizonDays(text);
    if (horizonDays !== null) found.push("horizon"); else assumed.push("horizon");

    const isShort = /\bshort\b|\bbet against\b|\bputs on\b/i.test(text) && !/\bshort term\b/i.test(text);
    const direction = isShort ? "short" : "long";
    if (isShort) found.push("direction"); else assumed.push("direction");
    c.needsShort = isShort;

    const lev = parseLeverage(text);
    if (lev !== null) { c.leverage = lev; found.push("leverage"); } else assumed.push("leverage");

    if (/\bdividend/i.test(text)) { c.wantsDividends = true; found.push("dividends"); }
    if (/\bvot(e|ing)\b|\bshareholder\b/i.test(text)) { c.wantsVoting = true; found.push("voting"); }
    if (/\bcollateral\b|\bborrow against\b/i.test(text)) { c.usesAsCollateral = true; found.push("collateral"); }
    if (/\boff hours\b|\bovernight exit\b|\bexit any time\b|\bweekend\b/i.test(text)) {
      c.needsOffHoursExit = true;
      found.push("off hours exit");
    }

    return {
      intent: {
        ticker: ticker ?? "",
        notionalUsd: notionalUsd ?? 2_000,
        direction,
        horizonDays: horizonDays ?? 30,
        constraints: c,
      },
      found,
      assumed,
      parser: "deterministic",
    };
  },
};

/**
 * Model parser, used only when a key is configured at build time.
 *
 * It returns the same object the deterministic parser returns and is validated against the
 * same shape. On any failure it falls back rather than blocking the surface, because a
 * parser outage must not become a product outage.
 */
export function createModelParser(apiKey: string | undefined): IntentParser {
  return {
    name: "model",
    available: Boolean(apiKey),
    async parse(text, knownTickers) {
      if (!apiKey) return deterministicParser.parse(text, knownTickers);
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: "claude-opus-5",
            max_tokens: 512,
            tools: [{
              name: "intent",
              description: "The parsed trading intent.",
              input_schema: {
                type: "object",
                properties: {
                  ticker: { type: "string", description: "US stock ticker, uppercase" },
                  notionalUsd: { type: "number" },
                  direction: { type: "string", enum: ["long", "short"] },
                  horizonDays: { type: "number" },
                  leverage: { type: "number" },
                  wantsDividends: { type: "boolean" },
                  wantsVoting: { type: "boolean" },
                  usesAsCollateral: { type: "boolean" },
                  needsOffHoursExit: { type: "boolean" },
                  found: { type: "array", items: { type: "string" } },
                },
                required: ["ticker", "notionalUsd", "direction", "horizonDays", "found"],
              },
            }],
            tool_choice: { type: "tool", name: "intent" },
            messages: [{
              role: "user",
              content:
                `Parse this into a trading intent. Only report fields the text actually states in "found".\n` +
                `Known tickers: ${knownTickers.slice(0, 200).join(" ")}\n\n${text}`,
            }],
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const use = json?.content?.find?.((c: { type: string }) => c.type === "tool_use");
        const a = use?.input;
        if (!a || typeof a.ticker !== "string") throw new Error("no structured output");

        const found: string[] = Array.isArray(a.found) ? a.found : [];
        const all = ["size", "horizon", "direction", "leverage"];
        return {
          intent: {
            ticker: String(a.ticker).toUpperCase(),
            notionalUsd: Number(a.notionalUsd) || 2_000,
            direction: a.direction === "short" ? "short" : "long",
            horizonDays: Number(a.horizonDays) || 30,
            constraints: {
              leverage: Number(a.leverage) || 1,
              needsShort: a.direction === "short",
              wantsDividends: Boolean(a.wantsDividends),
              wantsVoting: Boolean(a.wantsVoting),
              usesAsCollateral: Boolean(a.usesAsCollateral),
              needsOffHoursExit: Boolean(a.needsOffHoursExit),
            },
          },
          found,
          assumed: all.filter((f) => !found.includes(f)),
          parser: "model",
        };
      } catch (e) {
        const fallback = await deterministicParser.parse(text, knownTickers);
        return { ...fallback, note: `Model parser unavailable (${(e as Error).message}), read it directly instead.` };
      }
    },
  };
}

/** The parser the app uses. Model when a key exists, deterministic otherwise. */
export function getParser(): IntentParser {
  const key = (import.meta as { env?: Record<string, string> }).env?.VITE_ANTHROPIC_API_KEY;
  return key ? createModelParser(key) : deterministicParser;
}
