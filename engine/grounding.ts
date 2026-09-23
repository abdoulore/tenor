/**
 * Keeping the model honest about numbers.
 *
 * The model is allowed to explain a result and to answer questions about it. It is not allowed to
 * produce a figure. So every answer is checked: each number in the model's text has to match a
 * number in the fact sheet the engine produced, at the precision the model wrote it. If any
 * number cannot be traced, the whole answer is withheld and the page says why.
 *
 * The fact sheet is also what the model is given, so there is nothing it could legitimately need
 * that is not already on it.
 */

import { betterSession } from "./engine.ts";
import type { Quote, RouteId, Session } from "./types.ts";
import type { SplitPlan } from "./split.ts";
import type { ShareOutlook } from "./equity.ts";

const SESSION_WORDS: Record<string, string> = {
  premarket: "pre-market",
  regular: "US market hours",
  afterhours: "after-hours",
  overnight: "overnight",
  weekend: "the weekend",
};

/** Session boundaries in New York time, in minutes after midnight, weekdays only. */
const SESSION_HOURS: [Session, number, number][] = [
  ["premarket", 240, 570],
  ["regular", 570, 960],
  ["afterhours", 960, 1200],
  ["overnight", 1200, 240],
];

/**
 * When each session runs in the reader's own time zone, on the given day, so a question like
 * "what about at 3am" can be matched to a session without the model doing time arithmetic.
 * Worked out from the New York offset on that day, so daylight saving is handled for both zones.
 */
export function sessionHoursIn(timeZone: string, day = new Date()): string {
  const offsetMin = (tz: string) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(day);
    const g = (t: string) => Number(parts.find((x) => x.type === t)?.value);
    const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
    return Math.round((asUtc - day.getTime()) / 60_000);
  };
  const shift = offsetMin(timeZone) - offsetMin("America/New_York");
  const clock = (m: number) => {
    const t = (((m + shift) % 1440) + 1440) % 1440;
    return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  };
  return SESSION_HOURS.map(([s, from, to]) => `${SESSION_WORDS[s]} ${clock(from)} to ${clock(to)}`).join(", ");
}

/** Dollars written the way the page writes them: cents under $100, whole dollars above. */
const money = (x: number) => {
  const abs = Math.abs(x);
  const digits = abs >= 100 ? 0 : 2;
  return `${x < 0 ? "-" : ""}$${abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
const usd = (bp: number, notional: number) => money((bp / 10_000) * notional);
const NAME: Record<RouteId, string> = { rtoken: "the tokenized stock", perp: "the perpetual", stockplus: "Stock+" };
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
const dateWords = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export interface FactSheet {
  /** Plain lines, given to the model verbatim. */
  lines: string[];
  text: string;
}

/**
 * Everything the engine knows about the current result, as labelled lines. Money is in dollars on
 * the user's amount, because that is how the page speaks and how the model should.
 */
export function factSheet(
  quote: Quote,
  opts: {
    split?: SplitPlan | null;
    share?: ShareOutlook | null;
    sharePrice?: number | null;
    sessionSize?: number;
    /** The reader's time zone, for session hours. */
    timeZone?: string;
  } = {},
): FactSheet {
  const n = quote.intent.notionalUsd;
  const L: string[] = [];
  const i = quote.intent;

  L.push(`Company: ${i.ticker}. Amount: $${n.toLocaleString("en-US")}. Direction: ${i.direction}. Holding period: ${i.horizonDays} days. Leverage: ${i.constraints.leverage}x.`);
  L.push(`Right now it is ${SESSION_WORDS[quote.session] ?? quote.session}.`);

  for (const r of quote.routes) {
    const name = r.route === "rtoken" ? "Tokenized stock" : r.route === "perp" ? "Perpetual" : "Stock+";
    if (r.totalBp) {
      const parts = [`fee ${usd(r.feeBp ?? 0, n)}`, `spread and slippage ${usd(r.executionBp ?? 0, n)}`];
      if (r.route === "perp" && r.fundingBp) {
        const f = r.fundingBp;
        parts.push(usd(f.low, n) === usd(f.high, n)
          ? `funding ${usd(f.mid, n)}`
          : `funding ${usd(f.mid, n)}, could be ${usd(f.low, n)} to ${usd(f.high, n)}`);
      }
      L.push(`${name}: total ${usd(r.totalBp.mid, n)} (${parts.join("; ")}). Fee rate is ${r.feeProvenance ?? "published"}.`);
    } else {
      L.push(`${name}: not priced. ${r.reason ?? ""}`.trim());
    }
  }

  // The verdict, in the same cases and with the same figures as the page's headline.
  const best = quote.routes.find((r) => r.rank === 1);
  const second = quote.routes.find((r) => r.rank === 2);
  const s = opts.split;
  if (!best) {
    L.push(s?.worthIt && s.bestSingle === null
      ? `Verdict: neither can take the whole $${n.toLocaleString("en-US")} alone, but split across both it fills.`
      : "Verdict: there is no way to do this right now. All three are ruled out.");
  } else if (!second || !best.totalBp || !second.totalBp) {
    L.push(`Verdict: only ${NAME[best.route]} can be priced or can do what was asked.`);
  } else {
    const diff = second.totalBp.mid - best.totalBp.mid;
    const band = Math.max(...quote.routes.map((r) => (r.fundingBp ? r.fundingBp.high - r.fundingBp.low : 0)));
    if (band > Math.abs(diff)) {
      L.push(`Verdict: too close to call. ${cap(NAME[best.route])} is ahead by ${usd(diff, n)}, but funding could swing the result by ${usd(band, n)} over ${i.horizonDays} days. Buying and selling is the only part that can be priced firmly today.`);
    } else {
      L.push(`Verdict: use ${NAME[best.route]}. It saves ${usd(diff, n)}.`);
      L.push(quote.horizonDecides
        ? "The two are close enough that the holding period decides which is cheaper."
        : "What decides it is the cost of getting in and out, not the holding period.");
    }
  }

  // Same rule as the page: a split that does not help is only worth saying on a large order.
  if (s?.applicable) {
    const line = s.worthIt
      ? `Split: ${money(s.perpUsd)} through the perpetual and ${money(s.tokenUsd)} through the tokenized stock (${Math.round(s.perpShare * 100)}% perpetual), total ${money(s.totalUsd)}` +
        (s.bestSingle ? `, saving ${money(s.savingUsd)} against putting it all in ${NAME[s.bestSingle.route]}.` : ".")
      : n >= 10_000 ? "Splitting the order across both would not help at this amount." : null;
    if (line) L.push(line);
  }

  if (opts.timeZone) {
    L.push(`Sessions on weekdays, in the reader's time (${opts.timeZone}): ${sessionHoursIn(opts.timeZone)}. Saturday and Sunday are the weekend.`);
  }
  if (quote.outlook && opts.sessionSize) {
    for (const route of ["rtoken", "perp"] as const) {
      const rows = (quote.outlook[route] ?? []).filter((o) => o.executionBp !== null && o.emptyShare !== 1);
      if (!rows.length) continue;
      const name = route === "rtoken" ? "Tokenized stock" : "Perpetual";
      // Cheapest first, so the model reads a comparison rather than having to make one.
      const ranked = [...rows].sort((a, b) => a.executionBp! - b.executionBp!);
      L.push(`${name} typical spread and slippage by time of day on $${opts.sessionSize.toLocaleString("en-US")}, cheapest first: ` +
        ranked.map((o) => `${SESSION_WORDS[o.session as Session] ?? o.session} ${usd(o.executionBp!, opts.sessionSize!)}`).join(", ") + ".");
      const b = betterSession(quote.outlook[route], quote.session);
      L.push(b
        ? `${name} is usually ${usd(b.savingBp, n)} cheaper to trade in ${SESSION_WORDS[b.session]} than right now.`
        : `${name}: no time of day is usually meaningfully cheaper than right now.`);
    }
  }

  if (opts.sharePrice) L.push(`Share price on the US market: $${opts.sharePrice.toFixed(2)}.`);
  const sh = opts.share;
  if (sh) {
    if (sh.premiumBp !== null) {
      L.push(`The tokenized stock is priced ${Math.abs(sh.premiumBp / 100).toFixed(2)}% ${sh.premiumBp >= 0 ? "above" : "below"} the share.`);
    }
    if (sh.nextDividend) {
      const d = sh.nextDividend;
      L.push(`Next dividend: ${d.announced ? "announced for" : "projected around"} ${dateWords(d.date)}, $${d.amount.toFixed(2)} a share` +
        (d.yieldPct !== null ? `, ${money((d.yieldPct / 100) * n)} on this amount` : "") +
        `, ${d.inHorizon ? "inside" : "after"} the holding period. Whether Bitget passes dividends on is unconfirmed.`);
    }
    if (sh.nextEarnings) {
      const e = sh.nextEarnings;
      L.push(`Next earnings report: ${e.announced ? "announced for" : "projected around"} ${dateWords(e.date)}, ${e.inHorizon ? "inside" : "after"} the holding period.`);
    }
  }

  return { lines: L, text: L.join("\n") };
}

/** Every number written in a piece of text, as written: "1,234.50" stays with its two decimals. */
function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,+$/, "").replace(/,/g, ""));
}

/**
 * The numbers in `text` that cannot be traced to the fact sheet.
 *
 * A number is traced when some number on the sheet, rounded to the precision the text used,
 * equals it. So "$5.57" needs a 5.57 on the sheet, and "about $6" is allowed if the sheet has
 * 5.57, but "$6.20" is not. An empty result means every figure is grounded.
 */
export function ungroundedNumbers(text: string, sheet: FactSheet, question = ""): string[] {
  // Numbers the reader typed may be repeated back, "3am" for example. They are the reader's own.
  const allowed = numbersIn(`${sheet.text}
${question}`).map(Number).filter(Number.isFinite);
  const bad: string[] = [];
  for (const raw of numbersIn(text)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const dp = raw.includes(".") ? raw.split(".")[1].length : 0;
    const f = 10 ** dp;
    const traced = allowed.some((a) => Math.round(a * f) / f === value);
    if (!traced) bad.push(raw);
  }
  return [...new Set(bad)];
}

/**
 * House style for anything the model writes: no markdown, and no dashes used as punctuation.
 * A dash between two figures is a range and becomes "to".
 */
export function plainText(text: string): string {
  return text
    .replace(/\*\*|__|`/g, "")
    .replace(/(\d)\s*[\u2013\u2014]\s*(?=\$?\d)/g, "$1 to ")
    .replace(/\s*[\u2013\u2014]\s*/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
