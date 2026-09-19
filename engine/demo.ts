#!/usr/bin/env node
/**
 * Price five tickers end to end against live books, across all four sessions, with the full
 * breakdown. One of the five is deliberately a name with no market.
 *
 *   node engine/demo.ts
 *   node engine/demo.ts --tickers NVDA,SOXL --size 10000 --horizon 7
 */

import { join } from "node:path";
import { sessionLabel } from "./book.ts";
import { DEFAULT_FEES, FLIP_TEST_FEES, feeGapBp, roundTripFeeBp, unverifiedLegs } from "./fees.ts";
import { logPrediction } from "./predictions.ts";
import { betterSession, priceIntent } from "./engine.ts";
import { fetchBook, fetchFunding, resolvePair, sessionOutlook } from "./live.ts";
import { DEFAULT_CONSTRAINTS, type Intent, type Quote, type RouteResult, type Session } from "./types.ts";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/*
 * NVDA and MSFT sit inside the fee gap, so the horizon genuinely decides on them.
 * AAOI is liquid but wide, so execution decides.
 * SOXL has no rToken book in any session. That is a finding rather than an error, so it is
 * in the set deliberately.
 * HOOD is a large mover with a 36bp gap.
 */
const TICKERS = arg("--tickers", "NVDA,MSFT,AAOI,SOXL,HOOD").split(",").map((t) => t.trim().toUpperCase());
const SIZE = Number(arg("--size", "2000"));
const HORIZON = Number(arg("--horizon", "30"));
const DATA_DIR = arg("--data", join(process.cwd(), "sampler", "data"));
const PRED_DIR = arg("--predictions", join(process.cwd(), "engine", "predictions"));
const SESSIONS: Session[] = ["premarket", "regular", "afterhours", "overnight"];

const bpf = (x: number | null | undefined, dp = 2): string =>
  x === null || x === undefined ? "n/a" : `${x >= 0 ? "" : ""}${x.toFixed(dp)}bp`;

function rangef(r: { low: number; mid: number; high: number } | null): string {
  if (!r) return "n/a";
  if (Math.abs(r.high - r.low) < 0.005) return bpf(r.mid);
  return `${r.mid.toFixed(2)}bp (${r.low.toFixed(2)} to ${r.high.toFixed(2)})`;
}

function routeLine(r: RouteResult): string {
  const head = `    ${r.label.padEnd(18)}`;
  switch (r.status) {
    case "no_book":
      return `${head} NO BOOK          ${r.reason}`;
    case "cannot_fill":
      return `${head} CANNOT FILL      ${r.reason}`;
    case "ineligible":
      return `${head} INELIGIBLE       ${r.reason}`;
    case "modeled":
      return `${head} MODELED          ${r.reason}`;
    default: {
      const rank = r.rank === 1 ? "  <- cheapest" : "";
      const stale = r.status === "stale" ? "  STALE" : "";
      return (
        `${head} ${rangef(r.totalBp).padEnd(30)}` +
        `fee ${bpf(r.feeBp)}  exec ${bpf(r.executionBp)}  funding ${rangef(r.fundingBp)}${rank}${stale}`
      );
    }
  }
}

function printQuote(q: Quote, outlookFor: Awaited<ReturnType<typeof sessionOutlook>>): void {
  console.log(`\n  ${q.intent.ticker}  $${q.intent.notionalUsd.toLocaleString()}  ${q.intent.direction}  ${q.intent.horizonDays}d  [session: ${q.session}]`);
  for (const r of q.routes) console.log(routeLine(r));

  const best = q.routes.find((r) => r.rank === 1);
  if (best) {
    const other = q.routes.find((r) => r.rank === 2);
    if (other) {
      const diff = other.totalBp!.mid - best.totalBp!.mid;
      const usd = (diff / 10_000) * q.intent.notionalUsd;
      console.log(`    verdict: ${best.label} by ${diff.toFixed(2)}bp, which on $${q.intent.notionalUsd.toLocaleString()} is $${usd.toFixed(2)}`);
    } else {
      console.log(`    verdict: ${best.label}, the only route that can trade this`);
    }
  } else {
    console.log(`    verdict: nothing can trade this intent right now`);
  }

  console.log(`    horizon decides: ${q.horizonDecides ? "yes, execution is inside the fee gap" : "no, execution decides"}`);

  for (const route of ["rtoken", "perp"] as const) {
    const b = betterSession(outlookFor[route], q.session);
    if (b) {
      console.log(`    ${route}: ${b.session} is ${b.savingBp.toFixed(2)}bp cheaper than ${q.session} on sampled medians`);
    }
  }
  for (const w of q.warnings) console.log(`    note: ${w}`);
}

async function main(): Promise<void> {
  const liveSession = sessionLabel(new Date()) as Session;
  console.log("=".repeat(96));
  console.log("TENOR COST ENGINE");
  console.log("=".repeat(96));
  console.log(`  live session right now: ${liveSession}`);
  console.log(`  size $${SIZE.toLocaleString()}, horizon ${HORIZON}d, long`);
  console.log(`  fees: rToken round trip ${(roundTripFeeBp("rtoken", DEFAULT_FEES)).toFixed(2)}bp, perp round trip ${(roundTripFeeBp("perp", DEFAULT_FEES)).toFixed(2)}bp`);
  console.log(`  fee gap ${feeGapBp(DEFAULT_FEES).toFixed(2)}bp, against ${feeGapBp(FLIP_TEST_FEES).toFixed(2)}bp assumed by the flip test`);
  console.log(`  unverified fee rates: ${unverifiedLegs(DEFAULT_FEES).join(", ")}`);

  for (const ticker of TICKERS) {
    console.log("\n" + "-".repeat(96));
    const pair = await resolvePair(ticker);
    if (!pair) {
      console.log(`  ${ticker}: no rToken and perp pair on Bitget`);
      continue;
    }
    console.log(`  ${ticker}: ${pair.spotSymbol} against ${pair.perpSymbol}, funding every ${pair.fundingIntervalHours}h`);

    const [spotBook, perpBook, funding, outlook] = await Promise.all([
      fetchBook("SPOT", pair.spotSymbol).catch(() => ({ asks: [], bids: [], ts: null })),
      fetchBook("USDT-FUTURES", pair.perpSymbol).catch(() => ({ asks: [], bids: [], ts: null })),
      fetchFunding(pair.perpSymbol).catch(() => []),
      sessionOutlook(ticker, SIZE, DATA_DIR),
    ]);

    console.log(`  live books: rToken ${spotBook.asks.length}/${spotBook.bids.length} levels, perp ${perpBook.asks.length}/${perpBook.bids.length} levels, ${funding.length} funding settlements`);

    // Sampled session medians, the data the session chart draws.
    const row = (name: string, o: typeof outlook.rtoken): string =>
      `    ${name.padEnd(8)}` +
      SESSIONS.map((s) => {
        const e = o.find((x) => x.session === s);
        if (!e) return `${s}: no data`.padEnd(24);
        if (e.emptyShare === 1) return `${s}: no book`.padEnd(24);
        return `${s}: ${e.executionBp === null ? "n/a" : e.executionBp.toFixed(1) + "bp"}`.padEnd(24);
      }).join("");
    console.log("  sampled session medians:");
    console.log(row("rToken", outlook.rtoken));
    console.log(row("perp", outlook.perp));

    const intent: Intent = {
      ticker,
      notionalUsd: SIZE,
      direction: "long",
      horizonDays: HORIZON,
      constraints: { ...DEFAULT_CONSTRAINTS },
    };

    // The live session is priced from the live book.
    const live = priceIntent(intent, {
      session: liveSession,
      books: { rtoken: spotBook, perp: perpBook },
      funding,
      fundingIntervalHours: pair.fundingIntervalHours,
      outlook,
    });
    printQuote(live, outlook);

    // Log the live recommendation the moment it is made. These lines cannot be backfilled.
    const logged = await logPrediction(live, { dir: PRED_DIR, source: "demo" });
    if (!logged.ok) console.log(`    WARNING prediction log failed: ${logged.error}`);

    /*
     * The other three sessions are counterfactuals and must come from measured medians for
     * that session. Re-labelling the current book would print the current number four times
     * under four different headings, which is worse than saying nothing.
     */
    console.log("    same intent at other hours, from sampled medians:");
    for (const session of SESSIONS.filter((s) => s !== liveSession)) {
      const sampledBp = (route: "rtoken" | "perp"): number | null | undefined => {
        const e = outlook[route].find((x) => x.session === session);
        if (!e || e.samples === 0) return undefined;
        if (e.emptyShare === 1) return null;
        return e.executionBp ?? undefined;
      };
      const rtoken = sampledBp("rtoken");
      const perp = sampledBp("perp");
      if (rtoken === undefined && perp === undefined) {
        console.log(`      ${String(session).padEnd(11)} no samples yet`);
        continue;
      }
      const q = priceIntent(intent, {
        session,
        books: { rtoken: spotBook, perp: perpBook },
        funding,
        fundingIntervalHours: pair.fundingIntervalHours,
        outlook,
        executionBpOverride: { rtoken, perp },
      });
      const best = q.routes.find((r) => r.rank === 1);
      console.log(
        `      ${String(session).padEnd(11)} ${best ? `${best.label} at ${rangef(best.totalBp)}` : "nothing tradeable"}`,
      );
    }
  }
  console.log("\n" + "=".repeat(96));
}

main().catch((e) => { console.error(e); process.exit(1); });
