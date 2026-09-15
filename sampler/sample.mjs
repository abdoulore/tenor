#!/usr/bin/env node
/**
 * Tenor spread sampler
 *
 * Orderbook history cannot be backfilled, so this runs continuously from now until
 * submission. Every cycle it pulls both legs of every tradeable ticker, records the
 * spread and what it actually costs to fill $2,000 and $10,000, and appends one NDJSON
 * line per ticker per cycle.
 *
 * Endpoint: GET /api/v3/market/orderbook?category={SPOT|USDT-FUTURES}&symbol=&limit=150
 * One shape serves both legs. Levels come back as {a: [[price, qty]], b: [...], ts}.
 *
 * Zero dependencies. Node 20 or later for built in fetch.
 *
 *   node sampler/sample.mjs              run forever
 *   node sampler/sample.mjs --once       one cycle, then exit
 *   node sampler/sample.mjs --selftest   offline maths check, no network
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BASE, CANARY_LIQUID, CONTROL_THIN, buildUniverse, extractPlatformVolume, extractVolume, rowsOf,
} from "./universe.mjs";
import { FILL_SIZES_USD, legMetrics, sessionLabel, walk, levels } from "./depth.mjs";

const SCHEMA = 1;
const ARGS = new Set(process.argv.slice(2));
const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const CYCLE_MS = Number(flag("--interval", process.env.SAMPLE_INTERVAL_MS ?? 300_000));
const DATA_DIR = flag("--data", process.env.DATA_DIR ?? join(process.cwd(), "sampler", "data"));
const REQUEST_GAP_MS = Number(flag("--gap", process.env.REQUEST_GAP_MS ?? 70)); // documented limit is 20/sec/IP
const UNIVERSE_REFRESH_MS = 6 * 60 * 60 * 1000;
const ORDERBOOK_LIMIT = 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- http

let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + REQUEST_GAP_MS;
  if (at > now) await sleep(at - now);
}

async function getJson(url, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    await throttle();
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "tenor-sampler" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.code !== undefined && json.code !== "00000") {
        throw new Error(`Bitget ${json.code}: ${json.msg ?? ""}`);
      }
      return json.data;
    } catch (e) {
      lastErr = e;
      if (i < attempts) await sleep(400 * 2 ** i);
    }
  }
  throw new Error(`${url} failed: ${lastErr?.message ?? "unknown"}`);
}

const orderbookUrl = (category, symbol) =>
  `${BASE}/api/v3/market/orderbook?category=${category}&symbol=${encodeURIComponent(symbol)}&limit=${ORDERBOOK_LIMIT}`;

// ---------------------------------------------------------------- universe

async function loadUniverse() {
  const [spot, perp, spotTick, perpTick] = await Promise.all([
    getJson(`${BASE}/api/v3/market/instruments?category=SPOT`),
    getJson(`${BASE}/api/v3/market/instruments?category=USDT-FUTURES`),
    getJson(`${BASE}/api/v3/market/tickers?category=SPOT`).catch(() => null),
    getJson(`${BASE}/api/v3/market/tickers?category=USDT-FUTURES`).catch(() => null),
  ]);

  const volumes = { spot: new Map(), perp: new Map(), spotPlatform: new Map() };
  for (const [data, target] of [[spotTick, volumes.spot], [perpTick, volumes.perp]]) {
    for (const row of rowsOf(data)) {
      const sym = String(row.symbol ?? "").toUpperCase();
      const vol = extractVolume(row);
      if (sym && vol !== null) target.set(sym, vol);
    }
  }
  for (const row of rowsOf(spotTick)) {
    const sym = String(row.symbol ?? "").toUpperCase();
    const vol = extractPlatformVolume(row);
    if (sym && vol !== null) volumes.spotPlatform.set(sym, vol);
  }

  const u = buildUniverse(rowsOf(spot), rowsOf(perp), volumes);
  const liquid = u.pairs.filter((p) => !p.thin);
  const byTicker = new Map(u.pairs.map((p) => [p.ticker, p]));

  // Controls are named thin tickers, so depth on thin names can be compared against the
  // liquid set rather than assumed.
  const controls = CONTROL_THIN
    .map((t) => byTicker.get(t))
    .filter((p) => p && p.thin)
    .map((p) => ({ ...p, control: true }));

  const selected = [...liquid.map((p) => ({ ...p, control: false })), ...controls];
  const liveTickers = new Set(liquid.map((p) => p.ticker));
  const drift = {
    missingVsCanary: CANARY_LIQUID.filter((t) => !liveTickers.has(t)),
    newVsCanary: [...liveTickers].filter((t) => !CANARY_LIQUID.includes(t)),
  };
  return { selected, liquidCount: liquid.length, controlCount: controls.length, drift, meta: u };
}

// ---------------------------------------------------------------- sampling

async function sampleLeg(category, symbol) {
  const t0 = Date.now();
  try {
    const d = await getJson(orderbookUrl(category, symbol));
    const m = legMetrics(d?.a, d?.b);
    if (!m.ok) {
      return {
        symbol,
        empty: m.empty === true,
        error: m.empty === true ? undefined : m.reason,
        note: m.reason,
        latencyMs: Date.now() - t0,
      };
    }
    const { ok, ...rest } = m;
    const bookTs = Number(d?.ts);
    return {
      symbol,
      ...rest,
      bookTs: Number.isFinite(bookTs) ? bookTs : null,
      stalenessMs: Number.isFinite(bookTs) ? Date.now() - bookTs : null,
      latencyMs: Date.now() - t0,
    };
  } catch (e) {
    return { symbol, error: String(e?.message ?? e).slice(0, 200), latencyMs: Date.now() - t0 };
  }
}

async function sampleCycle(universe) {
  const startedAt = new Date();
  const session = sessionLabel(startedAt);
  const lines = [];
  let ok = 0;
  let failed = 0;
  let emptySpot = 0;
  let emptyPerp = 0;

  for (const pair of universe.selected) {
    // Legs are fetched together so the two books are as close in time as the throttle allows.
    const [spot, perp] = await Promise.all([
      sampleLeg("SPOT", pair.spotSymbol),
      sampleLeg("USDT-FUTURES", pair.perpSymbol),
    ]);

    const record = {
      v: SCHEMA,
      t: new Date().toISOString(),
      cycle: startedAt.toISOString(),
      session,
      ticker: pair.ticker,
      control: pair.control,
      perpVolume24h: pair.perpVolume24h,
      spotVolume24h: pair.spotVolume24h,
      spot,
      perp,
    };

    // The comparison the product rests on: rToken round trip minus perp round trip,
    // per size, in the same units as the 8bp fee gap.
    if (spot.empty) emptySpot++;
    if (perp.empty) emptyPerp++;

    if (spot.fills && perp.fills) {
      record.gapBp = {};
      for (const size of FILL_SIZES_USD) {
        const s = spot.fills[size].roundTripBp;
        const p = perp.fills[size].roundTripBp;
        record.gapBp[size] = s === null || p === null ? null : Math.round((s - p) * 1000) / 1000;
      }
      ok++;
    } else if (spot.error || perp.error) {
      failed++;
    }
    lines.push(JSON.stringify(record));
  }

  const day = startedAt.toISOString().slice(0, 10);
  const file = join(DATA_DIR, `samples-${day}.ndjson`);
  await appendFile(file, lines.join("\n") + "\n", "utf8");

  const status = {
    lastCycleStarted: startedAt.toISOString(),
    lastCycleFinished: new Date().toISOString(),
    durationSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
    session,
    tickers: universe.selected.length,
    ok,
    failed,
    emptySpotBooks: emptySpot,
    emptyPerpBooks: emptyPerp,
    file,
  };
  await writeFile(join(DATA_DIR, "status.json"), JSON.stringify(status, null, 2), "utf8");
  return status;
}

// ---------------------------------------------------------------- selftest

function selftest() {
  let failures = 0;
  const check = (name, cond, detail = "") => {
    if (cond) {
      console.log(`  pass  ${name}`);
    } else {
      console.log(`  FAIL  ${name} ${detail}`);
      failures++;
    }
  };
  console.log("sampler selftest");

  const asks = [[100.01, 100], [100.02, 100], [100.03, 100]];
  const bids = [[99.99, 100], [99.98, 100], [99.97, 100]];
  const m = legMetrics(asks, bids);
  check("book parses", m.ok === true);
  check("mid is 100", m.mid === 100, `got ${m.mid}`);
  check("spread is 2bp", Math.abs(m.spreadBp - 2) < 1e-6, `got ${m.spreadBp}`);

  // $2,000 fits inside the first ask level, worth $10,001, so cost is exactly half the spread.
  check("small buy pays half spread", Math.abs(m.fills[2000].buyBp - 1) < 1e-6, `got ${m.fills[2000].buyBp}`);
  check("small round trip equals the spread", Math.abs(m.fills[2000].roundTripBp - 2) < 1e-6, `got ${m.fills[2000].roundTripBp}`);
  check("small fill not exhausted", m.fills[2000].exhausted === false);

  // Impact only shows up when the size outruns the top level.
  const thin = legMetrics([[100.01, 20], [100.10, 200]], [[99.99, 20], [99.90, 200]]);
  check("thin book charges more for 10k than 2k", thin.fills[10000].buyBp > thin.fills[2000].buyBp,
    `${thin.fills[10000].buyBp} vs ${thin.fills[2000].buyBp}`);

  // A book too small to fill the size must report null, never a cheap looking number.
  const tiny = legMetrics([[100.01, 1]], [[99.99, 1]]);
  check("insufficient book reports null", tiny.fills[10000].buyBp === null, JSON.stringify(tiny.fills[10000]));
  check("insufficient book flags exhausted", tiny.fills[10000].exhausted === true);
  check("insufficient book still reports what filled", tiny.fills[10000].buyFilledUsd === 100);

  check("walk returns exact vwap on one level", Math.abs(walk([[10, 100]], 500).vwap - 10) < 1e-12);
  check("empty side rejected", legMetrics([], [[1, 1]]).ok === false);
  check("crossed book rejected", legMetrics([[99, 1]], [[101, 1]]).ok === false);
  check("string levels parse", levels([["1.5", "2"]])[0][0] === 1.5);
  check("zero size levels dropped", levels([[1, 0], [2, 1]]).length === 1);

  const d = (iso) => sessionLabel(new Date(iso));
  check("regular session", d("2026-09-15T14:00:00Z") === "regular", d("2026-09-15T14:00:00Z"));
  check("premarket session", d("2026-09-15T11:00:00Z") === "premarket", d("2026-09-15T11:00:00Z"));
  check("afterhours session", d("2026-09-15T21:00:00Z") === "afterhours", d("2026-09-15T21:00:00Z"));
  check("overnight session", d("2026-09-15T03:00:00Z") === "overnight", d("2026-09-15T03:00:00Z"));
  check("weekend session", d("2026-09-19T14:00:00Z") === "weekend", d("2026-09-19T14:00:00Z"));

  console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
  return failures ? 1 : 0;
}

// ---------------------------------------------------------------- main

async function main() {
  if (ARGS.has("--selftest")) process.exit(selftest());

  await mkdir(DATA_DIR, { recursive: true });
  log(`data dir ${DATA_DIR}`);
  log(`cycle every ${Math.round(CYCLE_MS / 1000)}s, request gap ${REQUEST_GAP_MS}ms`);

  let universe = null;
  let universeAt = 0;

  for (;;) {
    try {
      if (!universe || Date.now() - universeAt > UNIVERSE_REFRESH_MS) {
        universe = await loadUniverse();
        universeAt = Date.now();
        log(`universe: ${universe.liquidCount} liquid plus ${universe.controlCount} thin controls, ${universe.selected.length} tickers, ${universe.selected.length * 2} requests per cycle`);
        if (universe.drift.missingVsCanary.length) log(`drift, in flip test but not liquid now: ${universe.drift.missingVsCanary.join(" ")}`);
        if (universe.drift.newVsCanary.length) log(`drift, liquid now but not in flip test: ${universe.drift.newVsCanary.join(" ")}`);
        await writeFile(join(DATA_DIR, "universe.json"), JSON.stringify({ at: new Date().toISOString(), ...universe }, null, 2), "utf8");
      }

      const status = await sampleCycle(universe);
      log(`cycle done in ${status.durationSec}s, session ${status.session}, ${status.ok} priced, ${status.emptySpotBooks} empty rToken books, ${status.emptyPerpBooks} empty perp books, ${status.failed} failed`);
      if (ARGS.has("--once")) return;
    } catch (e) {
      // A sampler that dies loses data permanently, so nothing is allowed to escape this loop.
      log(`cycle error: ${e?.message ?? e}`);
      if (ARGS.has("--once")) process.exit(1);
    }
    await sleep(CYCLE_MS);
  }
}

main().catch((e) => {
  log("fatal", e);
  process.exit(1);
});
