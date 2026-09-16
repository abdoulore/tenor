/**
 * Bitget public API access, safe in both the browser and Node.
 *
 * Bitget returns `access-control-allow-origin: *` on GET, and these are simple GETs with no
 * custom headers, so no preflight is triggered and the browser can call them directly. That
 * is why Tenor is a static site with no proxy: fewer moving parts to fail on Sunday.
 *
 * Nothing here touches the filesystem. The parts that read collected data live in live.ts.
 */

import { toBook } from "./book.ts";
import type { Book } from "./types.ts";
import type { Settlement } from "./funding.ts";

export const BASE = "https://api.bitget.com";
const ORDERBOOK_LIMIT = 150;

let nextSlot = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Documented limit is 20 requests per second per IP. */
async function throttle(gapMs = 70): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gapMs;
  if (at > now) await sleep(at - now);
}

export async function getJson(url: string, attempts = 3): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    await throttle();
    try {
      // No custom headers on purpose: adding one turns this into a preflighted request,
      // and Bitget answers OPTIONS with a 403.
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { code?: string; msg?: string; data?: unknown };
      if (json.code !== undefined && json.code !== "00000") {
        throw new Error(`Bitget ${json.code}: ${json.msg ?? ""}`);
      }
      return json.data;
    } catch (e) {
      lastErr = e;
      if (i < attempts) await sleep(400 * 2 ** i);
    }
  }
  throw new Error(`${url} failed: ${(lastErr as Error)?.message ?? "unknown"}`);
}

export function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    for (const k of ["list", "resultList", "items", "rows", "data"]) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

export interface Pair {
  ticker: string;
  spotSymbol: string;
  perpSymbol: string;
  fundingIntervalHours: number;
}

/**
 * Resolve a ticker to its two legs.
 *
 * rTokens are flagged isReality on the v3 spot instruments. The perp must be marked isRwa
 * and must not be a commodity: CLUSDT and BZUSDT are crude oil, not Colgate.
 */
export async function resolvePair(ticker: string): Promise<Pair | null> {
  const t = ticker.trim().toUpperCase();
  const [spot, perp] = await Promise.all([
    getJson(`${BASE}/api/v3/market/instruments?category=SPOT`),
    getJson(`${BASE}/api/v3/market/instruments?category=USDT-FUTURES`),
  ]);

  let spotSymbol: string | null = null;
  for (const r of rowsOf(spot)) {
    const base = String(r.baseCoin ?? "").toUpperCase();
    const quote = String(r.quoteCoin ?? "").toUpperCase();
    const reality = String(r.isReality ?? r.isRwa ?? "").toLowerCase();
    if (quote !== "USDT" || reality !== "yes") continue;
    if (base.replace(/^R/i, "").toUpperCase() === t) { spotSymbol = String(r.symbol); break; }
  }
  if (!spotSymbol) return null;

  const perpRow = rowsOf(perp).find((r) => String(r.symbol).toUpperCase() === `${t}USDT`);
  if (!perpRow) return null;
  const kind = String(perpRow.symbolType ?? "").toUpperCase();
  const isRwa = String(perpRow.isRwa ?? perpRow.isReality ?? "").toLowerCase() === "yes";
  if (/COMMODITY|FOREX|FX|INDEX/.test(kind) || !isRwa) return null;

  const interval = Number(perpRow.fundInterval);
  return {
    ticker: t,
    spotSymbol,
    perpSymbol: String(perpRow.symbol),
    fundingIntervalHours: Number.isFinite(interval) && interval > 0 ? interval : 8,
  };
}

export async function fetchBook(category: "SPOT" | "USDT-FUTURES", symbol: string): Promise<Book> {
  const d = (await getJson(
    `${BASE}/api/v3/market/orderbook?category=${category}&symbol=${encodeURIComponent(symbol)}&limit=${ORDERBOOK_LIMIT}`,
  )) as { a?: unknown; b?: unknown; ts?: unknown };
  return toBook(d?.a, d?.b, d?.ts);
}

/** Funding settlements for a perp, oldest first. */
export async function fetchFunding(symbol: string, lookbackDays = 30): Promise<Settlement[]> {
  const out: Settlement[] = [];
  const since = Date.now() - lookbackDays * 86_400_000;
  for (let page = 1; page <= 4; page++) {
    let rows: Record<string, unknown>[] = [];
    try {
      rows = rowsOf(
        await getJson(
          `${BASE}/api/v3/market/history-fund-rate?category=USDT-FUTURES&symbol=${symbol}&limit=100&cursor=${page}`,
        ),
      );
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

/** Every ticker that has both legs, for the picker. */
export async function listTickers(): Promise<string[]> {
  const [spot, perp] = await Promise.all([
    getJson(`${BASE}/api/v3/market/instruments?category=SPOT`),
    getJson(`${BASE}/api/v3/market/instruments?category=USDT-FUTURES`),
  ]);
  const perps = new Map<string, Record<string, unknown>>();
  for (const r of rowsOf(perp)) perps.set(String(r.symbol).toUpperCase(), r);

  const out: string[] = [];
  for (const r of rowsOf(spot)) {
    const quote = String(r.quoteCoin ?? "").toUpperCase();
    const reality = String(r.isReality ?? r.isRwa ?? "").toLowerCase();
    if (quote !== "USDT" || reality !== "yes") continue;
    const t = String(r.baseCoin ?? "").replace(/^R/i, "").toUpperCase();
    const p = perps.get(`${t}USDT`);
    if (!p) continue;
    const kind = String(p.symbolType ?? "").toUpperCase();
    const isRwa = String(p.isRwa ?? p.isReality ?? "").toLowerCase() === "yes";
    if (/COMMODITY|FOREX|FX|INDEX/.test(kind) || !isRwa) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out.sort();
}
