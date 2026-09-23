/**
 * Live data for the engine: books, funding history, and the session outlook built from the
 * sampler's collected NDJSON.
 *
 * The outlook is what lets the engine answer gate 3, "at this hour", with measured numbers
 * rather than an assumption, and it is the same data the session chart draws.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { quoteBook, toBook } from "./book.ts";
// @ts-expect-error plain .mjs module, types declared in ../sampler/universe.d.mts
import { BASE, buildUniverse, extractVolume, rowsOf } from "../sampler/universe.mjs";
import type { Settlement } from "./funding.ts";
import type { Book, RouteId, Session, SessionOutlook } from "./types.ts";

const ORDERBOOK_LIMIT = 150;

let nextSlot = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, attempts = 3): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + 70;
    if (at > now) await sleep(at - now);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { code?: string; msg?: string; data?: unknown };
      if (json.code !== undefined && json.code !== "00000") throw new Error(`Bitget ${json.code}: ${json.msg ?? ""}`);
      return json.data;
    } catch (e) {
      lastErr = e;
      if (i < attempts) await sleep(400 * 2 ** i);
    }
  }
  throw new Error(`${url} failed: ${(lastErr as Error)?.message ?? "unknown"}`);
}

export interface Pair {
  ticker: string;
  spotSymbol: string;
  perpSymbol: string;
  fundingIntervalHours: number;
  perpVolume24h: number | null;
  spotPlatformVolume24h: number | null;
}

/** Resolve a ticker to its two legs using the sampler's universe logic. */
export async function resolvePair(ticker: string): Promise<Pair | null> {
  const [spot, perp, spotTick, perpTick] = await Promise.all([
    getJson(`${BASE}/api/v3/market/instruments?category=SPOT`),
    getJson(`${BASE}/api/v3/market/instruments?category=USDT-FUTURES`),
    getJson(`${BASE}/api/v3/market/tickers?category=SPOT`).catch(() => null),
    getJson(`${BASE}/api/v3/market/tickers?category=USDT-FUTURES`).catch(() => null),
  ]);

  const volumes = { spot: new Map(), perp: new Map(), spotPlatform: new Map() };
  for (const [data, target] of [[spotTick, volumes.spot], [perpTick, volumes.perp]] as const) {
    for (const row of rowsOf(data) as Record<string, unknown>[]) {
      const sym = String(row.symbol ?? "").toUpperCase();
      const vol = extractVolume(row);
      if (sym && vol !== null) target.set(sym, vol);
    }
  }
  for (const row of rowsOf(spotTick) as Record<string, unknown>[]) {
    const sym = String(row.symbol ?? "").toUpperCase();
    const v = Number(row.platformTurnover24h);
    if (sym && Number.isFinite(v)) volumes.spotPlatform.set(sym, v);
  }

  const u = buildUniverse(rowsOf(spot), rowsOf(perp), volumes) as {
    pairs: (Pair & { spotPlatformVolume24h: number | null })[];
  };
  const found = u.pairs.find((p) => p.ticker === ticker.toUpperCase());
  if (!found) return null;

  const perpRow = (rowsOf(perp) as Record<string, unknown>[]).find(
    (r) => String(r.symbol).toUpperCase() === found.perpSymbol.toUpperCase(),
  );
  const interval = Number(perpRow?.fundInterval);

  return {
    ticker: found.ticker,
    spotSymbol: found.spotSymbol,
    perpSymbol: found.perpSymbol,
    fundingIntervalHours: Number.isFinite(interval) && interval > 0 ? interval : 8,
    perpVolume24h: found.perpVolume24h ?? null,
    spotPlatformVolume24h: found.spotPlatformVolume24h ?? null,
  };
}

export async function fetchBook(category: "SPOT" | "USDT-FUTURES", symbol: string): Promise<Book> {
  const d = (await getJson(
    `${BASE}/api/v3/market/orderbook?category=${category}&symbol=${encodeURIComponent(symbol)}&limit=${ORDERBOOK_LIMIT}`,
  )) as { a?: unknown; b?: unknown; ts?: unknown };
  return toBook(d?.a, d?.b, d?.ts);
}

/** Bitget's quote for a tokenized stock, as a one level book. The same as bitget.ts. */
export async function fetchQuote(symbol: string): Promise<Book> {
  const rows = rowsOf(await getJson(`${BASE}/api/v3/market/tickers?category=SPOT&symbol=${encodeURIComponent(symbol)}`));
  return quoteBook(rows[0] ?? null);
}

/** Funding settlements for a perp, newest last. */
export async function fetchFunding(symbol: string, lookbackDays = 30): Promise<Settlement[]> {
  const out: Settlement[] = [];
  const since = Date.now() - lookbackDays * 86_400_000;
  for (let page = 1; page <= 4; page++) {
    let rows: Record<string, unknown>[] = [];
    try {
      rows = rowsOf(
        await getJson(`${BASE}/api/v3/market/history-fund-rate?category=USDT-FUTURES&symbol=${symbol}&limit=100&cursor=${page}`),
      ) as Record<string, unknown>[];
    } catch {
      break;
    }
    if (!rows.length) break;
    const before = out.length;
    for (const r of rows) {
      const ts = Number(r.fundingRateTimestamp ?? r.fundingTime ?? r.settleTime ?? r.ts);
      const rate = Number(r.fundingRate ?? r.fundRate);
      if (Number.isFinite(ts) && Number.isFinite(rate) && ts > 0) out.push({ ts, rate });
    }
    if (out.length === before) break;
    if (out.some((s) => s.ts < since)) break;
  }
  return out.filter((s) => s.ts >= since).sort((a, b) => a.ts - b.ts);
}

// ---------------------------------------------------------------- sampled outlook

const SESSIONS: Session[] = ["premarket", "regular", "afterhours", "overnight", "weekend"];

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Build the per route, per session outlook for one ticker from the sampler's files.
 *
 * `size` must be one of the sizes the sampler walked, currently 2000 or 10000. Asking for a
 * size it never measured returns empty rather than interpolating a number nobody observed.
 */
export async function sessionOutlook(
  ticker: string,
  size: number,
  dataDir: string,
): Promise<Record<RouteId, SessionOutlook[]>> {
  const acc: Record<string, Record<string, { rt: number[]; empty: number; n: number }>> = {
    rtoken: {},
    perp: {},
  };
  for (const s of SESSIONS) {
    acc.rtoken[s] = { rt: [], empty: 0, n: 0 };
    acc.perp[s] = { rt: [], empty: 0, n: 0 };
  }

  let files: string[] = [];
  try {
    files = (await readdir(dataDir)).filter((f) => f.startsWith("samples-") && f.endsWith(".ndjson")).sort();
  } catch {
    return { rtoken: [], perp: [], stockplus: [] };
  }

  const want = ticker.toUpperCase();
  for (const f of files) {
    const text = await readFile(join(dataDir, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim() || !line.includes(want)) continue;
      let r: Record<string, any>;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.ticker !== want) continue;
      /*
       * The tokenized stock is measured from its quote, which is what its orders fill at. Records
       * from before the sampler recorded quotes only have the order book, which real trades showed
       * overstates the cost, so those are left out for this route rather than mixed in.
       */
      for (const [route, leg] of [["rtoken", r.spotQuote], ["perp", r.perp]] as const) {
        if (route === "rtoken" && !leg) continue;
        const bucket = acc[route][r.session];
        if (!bucket) continue;
        bucket.n++;
        if (leg?.empty) bucket.empty++;
        const rt = leg?.fills?.[String(size)]?.roundTripBp;
        if (typeof rt === "number") bucket.rt.push(rt);
      }
    }
  }

  const build = (route: "rtoken" | "perp"): SessionOutlook[] =>
    SESSIONS.filter((s) => acc[route][s].n > 0).map((s) => {
      const b = acc[route][s];
      return {
        session: s,
        executionBp: median(b.rt),
        emptyShare: b.n ? b.empty / b.n : null,
        samples: b.n,
      };
    });

  return { rtoken: build("rtoken"), perp: build("perp"), stockplus: [] };
}
