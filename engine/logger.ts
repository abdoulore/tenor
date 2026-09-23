#!/usr/bin/env node
/**
 * Standing prediction logger.
 *
 * Runs the engine on a watchlist every 15 minutes and writes one prediction line per
 * ticker. Saturday's receipts are these lines compared against what actually happened, and
 * a prediction written after the fact is not a prediction, so this runs continuously from
 * today whether or not anything is reading it yet.
 *
 *   node engine/logger.ts                 run forever
 *   node engine/logger.ts --once          one pass, then exit
 *   node engine/logger.ts --tickers A,B   override the watchlist
 */

import { join } from "node:path";
import { sessionLabel } from "./book.ts";
import { priceIntent } from "./engine.ts";
import { fetchBook, fetchFunding, fetchQuote, resolvePair, sessionOutlook } from "./live.ts";
import { logPrediction } from "./predictions.ts";
import { DEFAULT_CONSTRAINTS, type Intent, type Session } from "./types.ts";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const ARGS = new Set(process.argv.slice(2));

/*
 * The watchlist deliberately spans all three states, in roughly equal thirds.
 *
 * It used to be ten names, of which exactly one had a dead market, which is why the
 * availability receipt had a sample of one and could say nothing. Twelve dead names give
 * that result something to stand on.
 *
 * This cannot be backfilled: a name added today has a week of history by the deadline, and
 * a name added on the last day has none. So breadth is worth buying early even though the
 * cost is more requests per pass.
 */
const LIQUID = "NVDA MSFT GOOGL SPY QQQ AAPL TSLA META AMZN MU SNDK PLTR";
/** Liquid enough to trade, but wide, where execution decides and the answer moves. */
const WIDE = "AAOI IONQ HOOD ORCL INTC COHR ASTS MARA QCOM WDC ABNB CRWV";
/** Listed by Bitget, never once quoted a price while we have been watching. */
const DEAD = "SOXL NFLX MCD LLY XOM GE UBER BA NKE PANW SMCI ZS";

const TICKERS = arg("--tickers", [LIQUID, WIDE, DEAD].join(" ").replace(/\s+/g, ","))
  .split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
const SIZES = arg("--sizes", "2000,10000").split(",").map(Number);
const HORIZON = Number(arg("--horizon", "30"));
const INTERVAL_MS = Number(arg("--interval", process.env.PREDICT_INTERVAL_MS ?? 900_000));
const DATA_DIR = arg("--data", join(process.cwd(), "sampler", "data"));
const PRED_DIR = arg("--predictions", join(process.cwd(), "engine", "predictions"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** Resolved once and reused, since instrument lists barely move and the calls are not free. */
const pairCache = new Map<string, Awaited<ReturnType<typeof resolvePair>>>();

async function pass(): Promise<{ written: number; failed: number }> {
  const session = sessionLabel(new Date()) as Session;
  let written = 0;
  let failed = 0;

  for (const ticker of TICKERS) {
    try {
      if (!pairCache.has(ticker)) pairCache.set(ticker, await resolvePair(ticker));
      const pair = pairCache.get(ticker);
      if (!pair) { failed++; continue; }

      // The tokenized stock is priced from its quote, which is what its orders fill at.
      const [spotBook, perpBook, funding, outlook] = await Promise.all([
        fetchQuote(pair.spotSymbol).catch(() => ({ asks: [], bids: [], ts: null, source: "quote" as const })),
        fetchBook("USDT-FUTURES", pair.perpSymbol).catch(() => ({ asks: [], bids: [], ts: null })),
        fetchFunding(pair.perpSymbol).catch(() => []),
        sessionOutlook(ticker, SIZES[0], DATA_DIR),
      ]);

      for (const notionalUsd of SIZES) {
        const intent: Intent = {
          ticker,
          notionalUsd,
          direction: "long",
          horizonDays: HORIZON,
          constraints: { ...DEFAULT_CONSTRAINTS },
        };
        const q = priceIntent(intent, {
          session,
          books: { rtoken: spotBook, perp: perpBook },
          funding,
          fundingIntervalHours: pair.fundingIntervalHours,
          outlook,
        });
        const res = await logPrediction(q, { dir: PRED_DIR, source: "logger" });
        if (res.ok) written++;
        else { failed++; log(`log failed for ${ticker}: ${res.error}`); }
      }
    } catch (e) {
      failed++;
      log(`${ticker} failed: ${(e as Error)?.message ?? e}`);
    }
  }
  return { written, failed };
}

async function main(): Promise<void> {
  log(`prediction logger: ${TICKERS.length} tickers x ${SIZES.length} sizes, every ${Math.round(INTERVAL_MS / 1000)}s`);
  log(`writing to ${PRED_DIR}`);
  for (;;) {
    const t0 = Date.now();
    try {
      const { written, failed } = await pass();
      const session = sessionLabel(new Date());
      log(`pass done in ${Math.round((Date.now() - t0) / 1000)}s, session ${session}, ${written} logged, ${failed} failed`);
    } catch (e) {
      // Losing a pass is bad. Dying is worse, because the gap cannot be filled in later.
      log(`pass error: ${(e as Error)?.message ?? e}`);
    }
    if (ARGS.has("--once")) return;
    await sleep(INTERVAL_MS);
  }
}

main().catch((e) => { log("fatal", e); process.exit(1); });
