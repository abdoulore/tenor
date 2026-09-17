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
/**
 * Model parser. Calls this app's own endpoint, never Anthropic directly.
 *
 * The key stays on the server. Vite inlines anything prefixed VITE_ into the deployed
 * bundle, so a key shipped that way is readable by every visitor, which is not an
 * acceptable way to hold a credential.
 *
 * It returns the same object the deterministic parser returns, and falls back to it on any
 * failure, because a parser outage must not become a product outage.
 */
export function createModelParser(endpoint = "/api/parse"): IntentParser {
  return {
    name: "model",
    available: true,
    async parse(text, knownTickers) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, tickers: knownTickers.slice(0, 250) }),
          signal: AbortSignal.timeout(25_000),
        });
        if (!res.ok) throw new Error(res.status === 503 ? "no key configured" : `HTTP ${res.status}`);
        const out = await res.json();
        const a = out?.input;
        if (!a || typeof a.ticker !== "string") throw new Error("no structured output");

        const found: string[] = Array.isArray(a.found) ? a.found.map(String) : [];

        /*
         * A value the model did not find in the text is a guess, and a guess presented as a
         * parsed number is exactly what this product exists not to do.
         *
         * "I want to bet against tesla for a couple of weeks" came back with
         * notionalUsd 10000, correctly left out of `found`, but 10,000 is nowhere in that
         * sentence. Fields are taken only when the model listed them as found; everything
         * else falls to the same defaults the rules parser uses and is labelled assumed.
         */
        const has = (...names: string[]) => names.some((n) => found.includes(n));
        const num = (v: unknown, fallback: number, present: boolean) => {
          if (!present) return fallback;
          const n = Number(v);
          return Number.isFinite(n) && n > 0 ? n : fallback;
        };

        const direction = has("direction") && a.direction === "short" ? "short" : "long";
        const all = ["ticker", "size", "horizon", "direction", "leverage"];
        const normalised = found.map((f) =>
          f === "notionalUsd" ? "size" : f === "horizonDays" ? "horizon" : f,
        );

        return {
          intent: {
            ticker: String(a.ticker ?? "").toUpperCase(),
            notionalUsd: num(a.notionalUsd, 2_000, has("size", "notionalUsd")),
            direction,
            horizonDays: num(a.horizonDays, 30, has("horizon", "horizonDays")),
            constraints: {
              leverage: num(a.leverage, 1, has("leverage")),
              needsShort: direction === "short",
              wantsDividends: has("wantsDividends", "dividends") && Boolean(a.wantsDividends),
              wantsVoting: has("wantsVoting", "voting") && Boolean(a.wantsVoting),
              usesAsCollateral: has("usesAsCollateral", "collateral") && Boolean(a.usesAsCollateral),
              needsOffHoursExit: has("needsOffHoursExit", "off hours exit") && Boolean(a.needsOffHoursExit),
            },
          },
          found: normalised,
          assumed: all.filter((f) => !normalised.includes(f)),
          parser: "model",
        };
      } catch (e) {
        const fallback = await deterministicParser.parse(text, knownTickers);
        return { ...fallback, note: `Read by rules, not the model (${(e as Error).message}).` };
      }
    },
  };
}

/**
 * The parser the app uses.
 *
 * Always the model parser, because it falls back to the rules parser by itself when the
 * endpoint is unconfigured or unreachable. There is no build-time key to branch on any
 * more, which is the point: the browser never holds one.
 */
export function getParser(): IntentParser {
  return createModelParser();
}
