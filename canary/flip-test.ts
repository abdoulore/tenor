/**
 * Route flip test
 *
 * One question: for a plain long stock bet on Bitget, does the cheapest wrapper
 * ever actually change? If rToken always wins, there is nothing to recommend and
 * Route is a static chart, not a product.
 *
 * Method, per ticker that has both an rToken and a stock perp:
 *   perp cost over H days  = round-trip perp fees + funding paid over H days
 *   rToken cost over H days = round-trip spot fees
 *   crossover T* = (spotFeeRT - perpFeeRT) / dailyFunding
 * Below T* the perp is cheaper, above it the rToken is. If T* sits inside the
 * horizons people actually hold, and moves over time, the recommendation is real.
 *
 * Deliberately NOT modeled: spreads (Bitget exposes no historical orderbook),
 * dividends, Stock+, collateral value, slippage. Those all push toward the
 * rToken, so a NO-GO here is decisive while a GO still needs the cost model.
 *
 * Run: npx tsx flip-test.ts --selftest      (offline math check, no network)
 *      npx tsx flip-test.ts                 (live)
 */

const BASE = "https://api.bitget.com";

// ---------------------------------------------------------------- config

interface Config {
  /** One-way taker fee on rToken spot, as a fraction. Standard Bitget spot taker is 0.1%. */
  spotTakerFee: number;
  /** One-way taker fee on USDT-margined perps, as a fraction. */
  perpTakerFee: number;
  /** Holding horizons in days that the verdict is judged over. */
  horizons: number[];
  /** Days of funding history to pull per symbol. */
  lookbackDays: number;
  /** Trailing window used to estimate forward funding, using only prior data. */
  trailingDays: number;
  /** Max tickers to test. 0 means all matched. */
  maxTickers: number;
  /** A horizon counts as contested when the perp wins on a share inside these bounds. */
  contestedLow: number;
  contestedHigh: number;
  /** Fraction of tickers whose median crossover must land inside [1, 60] days. */
  minTickersInRange: number;
  /** A perp below this 24h quote volume is too thin to be a real route. */
  minPerpQuoteVolume24h: number;
  /** Same for the rToken leg. */
  minSpotQuoteVolume24h: number;
  requestIntervalMs: number;
}

const CONFIG: Config = {
  spotTakerFee: 0.001,
  perpTakerFee: 0.0006,
  horizons: [1, 3, 7, 14, 30, 90],
  lookbackDays: 120,
  trailingDays: 7,
  maxTickers: 0,
  contestedLow: 0.15,
  contestedHigh: 0.85,
  minTickersInRange: 0.25,
  minPerpQuoteVolume24h: 250_000,
  minSpotQuoteVolume24h: 50_000,
  requestIntervalMs: 70, // documented limit is 20/sec/IP
};

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- http

let nextSlot = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function throttle(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + CONFIG.requestIntervalMs;
  if (slot > now) await sleep(slot - now);
}

interface Envelope {
  code?: string;
  msg?: string;
  data?: unknown;
}

async function getJson(url: string, attempts = 4): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    await throttle();
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const body = await res.text();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(500 * 2 ** i);
        continue;
      }
      const json = JSON.parse(body) as Envelope;
      if (json.code !== undefined && json.code !== "00000") {
        throw new Error(`Bitget ${json.code}: ${json.msg ?? ""}`);
      }
      return json.data;
    } catch (e) {
      lastErr = e;
      if (i === attempts) break;
      await sleep(500 * 2 ** i);
    }
  }
  throw new Error(`${url} failed: ${(lastErr as Error)?.message ?? "unknown"}`);
}

function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    for (const k of ["list", "resultList", "items", "rows", "data"]) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

const str = (r: Record<string, unknown>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return "";
};

// ---------------------------------------------------------------- instruments

export interface Pair {
  ticker: string;
  spotSymbol: string;
  perpSymbol: string;
  fundingIntervalHours: number;
  intervalSource: "instrument" | "assumed";
  perpVolume24h: number | null;
  spotVolume24h: number | null;
  thin: boolean;
}

export interface Universe {
  pairs: Pair[];
  excluded: { ticker: string; reason: string }[];
  rTokenCount: number;
  perpCount: number;
  realityFlagOnSpot: boolean;
  perpFilter: "marker" | "collision";
}

/** rTokens are flagged isReality=yes; fall back to an R-prefixed base coin against USDT. */
export function extractRTokens(rows: Record<string, unknown>[]): { rTokens: Map<string, string>; flagPresent: boolean } {
  const rTokens = new Map<string, string>();
  const flagPresent = rows.some((r) => str(r, "isReality") !== "");
  for (const r of rows) {
    const symbol = str(r, "symbol");
    const base = str(r, "baseCoin", "baseCurrency").toUpperCase();
    const quote = str(r, "quoteCoin", "quoteCurrency").toUpperCase();
    const reality = str(r, "isReality").toLowerCase();
    if (!symbol || quote !== "USDT") continue;
    const isR = flagPresent ? reality === "yes" : /^R[A-Z]{1,6}$/.test(base);
    if (!isR) continue;
    const ticker = base.replace(/^R/, "");
    if (ticker.length < 1) continue;
    if (!rTokens.has(ticker)) rTokens.set(ticker, symbol);
  }
  return { rTokens, flagPresent };
}

/**
 * Base coins of every non-Reality spot listing. Any perp whose ticker sits in this set is
 * ambiguous: BCH is both Banco de Chile and Bitcoin Cash, and BCHUSDT is the crypto perp.
 * Pairing an rToken against it compares a bank to a coin.
 */
export function cryptoSpotBases(rows: Record<string, unknown>[], flagPresent: boolean): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const base = str(r, "baseCoin", "baseCurrency").toUpperCase();
    if (!base) continue;
    const reality = str(r, "isReality").toLowerCase();
    const isR = flagPresent ? reality === "yes" : /^R[A-Z]{1,6}$/.test(base);
    if (!isR) out.add(base);
  }
  return out;
}

/** A positive stock marker on the perp instrument, if Bitget ships one. */
export function perpIsStock(r: Record<string, unknown>): boolean | null {
  const reality = str(r, "isReality").toLowerCase();
  if (reality === "yes") return true;
  if (reality === "no") return false;
  const kind = str(r, "symbolType", "instType", "assetType", "underlyingType", "businessType").toUpperCase();
  if (!kind) return null;
  if (/STOCK|EQUITY|TRADFI|REALITY/.test(kind)) return true;
  if (/CRYPTO|COIN|DIGITAL/.test(kind)) return false;
  return null;
}

export function extractFundingInterval(r: Record<string, unknown>): number | null {
  const raw = str(r, "fundInterval", "fundingInterval", "fundIntervalHours", "settleInterval", "fundingIntervalHours");
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Some responses report minutes or milliseconds rather than hours.
  if (n >= 3_600_000) return n / 3_600_000;
  if (n >= 60) return n / 60;
  return n;
}

/** 24h quote (USDT) volume from a tickers response, whatever the field is called. */
export function extractVolume(r: Record<string, unknown>): number | null {
  const raw = str(r, "usdtVolume", "quoteVolume", "turnover24h", "quoteVol", "volumeUsdt", "usdtVol");
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function buildUniverse(
  spotRows: Record<string, unknown>[],
  perpRows: Record<string, unknown>[],
  volumes: { spot: Map<string, number>; perp: Map<string, number> },
  cfg: Config,
): Universe {
  const { rTokens, flagPresent } = extractRTokens(spotRows);
  const cryptoBases = cryptoSpotBases(spotRows, flagPresent);

  const perps = new Map<string, Record<string, unknown>>();
  let marked = 0;
  for (const r of perpRows) {
    const symbol = str(r, "symbol").toUpperCase();
    if (!symbol) continue;
    perps.set(symbol, r);
    if (perpIsStock(r) === true) marked++;
  }
  // Only trust a positive marker if it actually classifies a meaningful slice.
  const perpFilter: Universe["perpFilter"] = marked >= 20 ? "marker" : "collision";

  const pairs: Pair[] = [];
  const excluded: { ticker: string; reason: string }[] = [];
  for (const [ticker, spotSymbol] of rTokens) {
    const perpSymbol = `${ticker}USDT`;
    const row = perps.get(perpSymbol);
    if (!row) continue;

    if (perpFilter === "marker") {
      if (perpIsStock(row) !== true) {
        excluded.push({ ticker, reason: `${perpSymbol} is not marked as a stock perp` });
        continue;
      }
    } else if (cryptoBases.has(ticker)) {
      excluded.push({ ticker, reason: `${ticker} is also a crypto listed on spot, so ${perpSymbol} is probably the crypto perp` });
      continue;
    }

    const perpVolume24h = volumes.perp.get(perpSymbol) ?? null;
    const spotVolume24h = volumes.spot.get(str(row, "symbol").toUpperCase()) ?? volumes.spot.get(spotSymbol.toUpperCase()) ?? null;
    const thin =
      (perpVolume24h !== null && perpVolume24h < cfg.minPerpQuoteVolume24h) ||
      (spotVolume24h !== null && spotVolume24h < cfg.minSpotQuoteVolume24h);

    const interval = extractFundingInterval(row);
    pairs.push({
      ticker,
      spotSymbol,
      perpSymbol: str(row, "symbol"),
      fundingIntervalHours: interval ?? 8,
      intervalSource: interval ? "instrument" : "assumed",
      perpVolume24h,
      spotVolume24h,
      thin,
    });
  }
  pairs.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return { pairs, excluded, rTokenCount: rTokens.size, perpCount: perps.size, realityFlagOnSpot: flagPresent, perpFilter };
}

// ---------------------------------------------------------------- funding history

export interface Funding {
  ts: number;
  rate: number;
}

export function parseFundingRows(rows: Record<string, unknown>[]): Funding[] {
  const out: Funding[] = [];
  for (const r of rows) {
    const ts = Number(str(r, "fundingRateTimestamp", "fundingTime", "settleTime", "ts"));
    const rate = Number(str(r, "fundingRate", "fundRate"));
    if (Number.isFinite(ts) && Number.isFinite(rate) && ts > 0) out.push({ ts, rate });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * Pages backward. The v3 endpoint takes a cursor documented only as an example
 * value, so this walks it as a page index and stops as soon as the page adds
 * nothing older, which is safe whatever the cursor actually means.
 */
async function fetchFunding(symbol: string, sinceMs: number): Promise<{ series: Funding[]; source: string }> {
  const attempts = [
    { source: "v3", url: (page: number) => `${BASE}/api/v3/market/history-fund-rate?category=USDT-FUTURES&symbol=${symbol}&limit=100&cursor=${page}` },
    { source: "v2", url: (page: number) => `${BASE}/api/v2/mix/market/history-fund-rate?symbol=${symbol}&productType=usdt-futures&pageSize=100&pageNo=${page}` },
  ];
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      const byTs = new Map<number, Funding>();
      let oldest = Infinity;
      for (let page = 1; page <= 40; page++) {
        const rows = parseFundingRows(rowsOf(await getJson(a.url(page))));
        if (rows.length === 0) break;
        let added = 0;
        for (const f of rows) {
          if (!byTs.has(f.ts)) {
            byTs.set(f.ts, f);
            added++;
          }
        }
        const pageOldest = rows[0].ts;
        if (added === 0 || pageOldest >= oldest) break;
        oldest = pageOldest;
        if (pageOldest <= sinceMs) break;
      }
      const series = [...byTs.values()].filter((f) => f.ts >= sinceMs).sort((x, y) => x.ts - y.ts);
      if (series.length > 0) return { series, source: a.source };
      errors.push(`${a.source}: empty`);
    } catch (e) {
      errors.push(`${a.source}: ${(e as Error).message}`);
    }
  }
  throw new Error(errors.join("; "));
}

// ---------------------------------------------------------------- the math

/**
 * Crossover in days: below it the perp is cheaper, above it the rToken is.
 * Infinity means the perp always wins (funding is zero or pays the long).
 * Zero means the perp never wins.
 */
export function crossoverDays(dailyFunding: number, spotFeeRT: number, perpFeeRT: number): number {
  const feeGap = spotFeeRT - perpFeeRT;
  if (dailyFunding <= 0) return feeGap >= 0 ? Infinity : 0;
  if (feeGap <= 0) return 0;
  return feeGap / dailyFunding;
}

/** Mean settlement rate over the trailing window, scaled to a daily rate. */
export function trailingDailyFunding(series: Funding[], atMs: number, windowDays: number, intervalHours: number): number | null {
  const from = atMs - windowDays * DAY_MS;
  const window = series.filter((f) => f.ts > from && f.ts <= atMs);
  if (window.length === 0) return null;
  const mean = window.reduce((s, f) => s + f.rate, 0) / window.length;
  return mean * (24 / intervalHours);
}

/** Funding actually paid by a long over the H days after atMs, as a fraction of notional. */
export function realizedFunding(series: Funding[], atMs: number, horizonDays: number): { cost: number; settlements: number } {
  const to = atMs + horizonDays * DAY_MS;
  let cost = 0;
  let settlements = 0;
  for (const f of series) {
    if (f.ts > atMs && f.ts <= to) {
      cost += f.rate;
      settlements++;
    }
  }
  return { cost, settlements };
}

export interface TickerResult {
  ticker: string;
  perpVolume24h: number | null;
  spotVolume24h: number | null;
  thin: boolean;
  settlements: number;
  days: number;
  fundingIntervalHours: number;
  intervalSource: "instrument" | "assumed";
  medianDailyFunding: number;
  negativeFundingShare: number;
  medianCrossover: number;
  p25Crossover: number;
  p75Crossover: number;
  /** Share of sampled days on which the perp is the cheaper route, per horizon. */
  perpWinShare: Record<number, number>;
  /** Times the recommendation changed across the sampled days, per horizon. */
  flips: Record<number, number>;
  /** Share of sampled days where the trailing estimate picked the same route as hindsight. */
  hindsightAgreement: Record<number, number>;
  sampledDays: number;
  error?: string;
}

export function analyze(pair: Pair, series: Funding[], cfg: Config): TickerResult {
  const spotFeeRT = cfg.spotTakerFee * 2;
  const perpFeeRT = cfg.perpTakerFee * 2;
  const base: TickerResult = {
    ticker: pair.ticker,
    perpVolume24h: pair.perpVolume24h,
    spotVolume24h: pair.spotVolume24h,
    thin: pair.thin,
    settlements: series.length,
    days: 0,
    fundingIntervalHours: pair.fundingIntervalHours,
    intervalSource: pair.intervalSource,
    medianDailyFunding: NaN,
    negativeFundingShare: NaN,
    medianCrossover: NaN,
    p25Crossover: NaN,
    p75Crossover: NaN,
    perpWinShare: {},
    flips: {},
    hindsightAgreement: {},
    sampledDays: 0,
  };
  if (series.length < 10) return { ...base, error: "not enough funding history" };

  const first = series[0].ts;
  const last = series[series.length - 1].ts;
  base.days = Math.round((last - first) / DAY_MS);
  base.negativeFundingShare = series.filter((f) => f.rate < 0).length / series.length;

  // Sample one decision per day, using only funding known at that point.
  const startMs = first + cfg.trailingDays * DAY_MS;
  const crossovers: number[] = [];
  const dailies: number[] = [];
  const decisions: { atMs: number; cross: number }[] = [];
  for (let t = startMs; t <= last; t += DAY_MS) {
    const daily = trailingDailyFunding(series, t, cfg.trailingDays, pair.fundingIntervalHours);
    if (daily === null) continue;
    dailies.push(daily);
    const cross = crossoverDays(daily, spotFeeRT, perpFeeRT);
    crossovers.push(cross);
    decisions.push({ atMs: t, cross });
  }
  if (decisions.length === 0) return { ...base, error: "no sampled days" };
  base.sampledDays = decisions.length;
  base.medianDailyFunding = quantile(dailies, 0.5);
  base.medianCrossover = quantile(crossovers, 0.5);
  base.p25Crossover = quantile(crossovers, 0.25);
  base.p75Crossover = quantile(crossovers, 0.75);

  for (const h of cfg.horizons) {
    let perpWins = 0;
    let flips = 0;
    let prev: boolean | null = null;
    let agree = 0;
    let scored = 0;
    for (const d of decisions) {
      const perpNow = d.cross > h;
      if (perpNow) perpWins++;
      if (prev !== null && perpNow !== prev) flips++;
      prev = perpNow;

      // Hindsight: did the route it picked actually turn out cheaper?
      const { cost, settlements } = realizedFunding(series, d.atMs, h);
      const expected = Math.round((h * 24) / pair.fundingIntervalHours);
      if (settlements >= expected * 0.8) {
        const perpActual = perpFeeRT + cost;
        const perpTrulyCheaper = perpActual < spotFeeRT;
        if (perpNow === perpTrulyCheaper) agree++;
        scored++;
      }
    }
    base.perpWinShare[h] = perpWins / decisions.length;
    base.flips[h] = flips;
    base.hindsightAgreement[h] = scored > 0 ? agree / scored : NaN;
  }
  return base;
}

export function quantile(xs: number[], q: number): number {
  const finite = xs.filter(Number.isFinite).sort((a, b) => a - b);
  const infinities = xs.length - finite.length;
  // Infinities sort to the top; index into the combined ordering.
  const all = [...finite, ...Array(infinities).fill(Infinity)];
  if (all.length === 0) return NaN;
  const i = (all.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return all[lo];
  if (!Number.isFinite(all[lo]) || !Number.isFinite(all[hi])) return all[hi];
  return all[lo] + (all[hi] - all[lo]) * (i - lo);
}

// ---------------------------------------------------------------- verdict

export interface Verdict {
  overall: "GO" | "NO-GO";
  reasons: string[];
  contestedHorizons: number[];
  tickersInRange: number;
  tickersScored: number;
  /** Liquid tickers whose answer actually moves. This is the product's universe. */
  shortlist: string[];
}

export function verdict(results: TickerResult[], cfg: Config): Verdict {
  const usable = results.filter((r) => !r.error);
  const scored = usable.filter((r) => !r.thin);
  const reasons: string[] = [];
  if (scored.length === 0) {
    const why = usable.length === 0 ? "No ticker produced usable funding history." : `All ${usable.length} tickers with funding history are too thin to trade.`;
    return { overall: "NO-GO", reasons: [why], contestedHorizons: [], tickersInRange: 0, tickersScored: 0, shortlist: [] };
  }
  const thin = usable.length - scored.length;
  if (thin > 0) reasons.push(`${thin} of ${usable.length} tickers dropped as too thin to trade; the verdict uses the remaining ${scored.length}.`);

  const inRange = scored.filter((r) => r.medianCrossover >= 1 && r.medianCrossover <= 60).length;
  const rangeShare = inRange / scored.length;

  const contested: number[] = [];
  for (const h of cfg.horizons) {
    const shares = scored.map((r) => r.perpWinShare[h]).filter(Number.isFinite);
    if (shares.length === 0) continue;
    const share = shares.reduce((a, b) => a + b, 0) / shares.length;
    if (share >= cfg.contestedLow && share <= cfg.contestedHigh) contested.push(h);
  }

  const anyFlips = scored.some((r) => cfg.horizons.some((h) => (r.flips[h] ?? 0) > 0));

  if (rangeShare >= cfg.minTickersInRange) {
    reasons.push(`${inRange} of ${scored.length} tickers have a median crossover between 1 and 60 days.`);
  } else {
    reasons.push(`Only ${inRange} of ${scored.length} tickers cross over inside 1 to 60 days, below the ${Math.round(cfg.minTickersInRange * 100)}% bar.`);
  }
  if (contested.length > 0) reasons.push(`The cheaper route is genuinely contested at ${contested.join(", ")} day horizons.`);
  else reasons.push("No horizon is contested: one route wins almost everywhere, so there is nothing to recommend.");
  if (!anyFlips) reasons.push("The recommendation never changed over the sample, so the monitor has nothing to monitor.");

  const shortlist = scored
    .filter((r) => r.medianCrossover >= 1 && r.medianCrossover <= 60 && cfg.horizons.some((h) => (r.flips[h] ?? 0) > 0))
    .sort((a, b) => (b.perpVolume24h ?? 0) - (a.perpVolume24h ?? 0))
    .map((r) => r.ticker);

  const overall = rangeShare >= cfg.minTickersInRange && contested.length > 0 && anyFlips ? "GO" : "NO-GO";
  return { overall, reasons, contestedHorizons: contested, tickersInRange: inRange, tickersScored: scored.length, shortlist };
}

// ---------------------------------------------------------------- output

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "n/a");
const days = (x: number) => (x === Infinity ? "always" : x === 0 ? "never" : x < 1 ? `${(x * 24).toFixed(1)}h` : `${x.toFixed(1)}d`);
const bp = (x: number) => (Number.isFinite(x) ? `${(x * 10000).toFixed(2)}bp` : "n/a");
const vol = (x: number | null) => {
  if (x === null) return "n/a";
  if (x >= 1e9) return `${(x / 1e9).toFixed(1)}B`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(0)}K`;
  return x.toFixed(0);
};

function report(results: TickerResult[], v: Verdict, cfg: Config, meta: string[], excluded: { ticker: string; reason: string }[] = []): string {
  const out: string[] = [];
  const scored = results.filter((r) => !r.error);
  out.push("", "=".repeat(78), `ROUTE FLIP TEST: ${v.overall}`, "=".repeat(78), "");
  for (const r of v.reasons) out.push(`  ${r}`);
  out.push("");
  for (const m of meta) out.push(`  ${m}`);
  out.push("");
  out.push(`  Assumed fees: spot ${bp(cfg.spotTakerFee)} per side, perp ${bp(cfg.perpTakerFee)} per side.`);
  out.push(`  Round trip: rToken ${bp(cfg.spotTakerFee * 2)}, perp ${bp(cfg.perpTakerFee * 2)}. Gap ${bp(cfg.spotTakerFee * 2 - cfg.perpTakerFee * 2)}.`);
  out.push("");

  if (v.shortlist.length > 0) {
    out.push("SHORTLIST: liquid tickers whose answer actually moves", "");
    out.push(`  ${v.shortlist.join(" ")}`);
    out.push("", "  This is the product's universe. Everything outside it has a static answer.", "");
  }

  const liquid = scored.filter((r) => !r.thin);
  const thin = scored.filter((r) => r.thin);
  const table = (rows: TickerResult[], title: string) => {
    if (rows.length === 0) return;
    out.push(title, "");
    const head = ["ticker", "perp vol", "days", "med daily fund", "crossover p25/med/p75", "neg fund", ...cfg.horizons.map((h) => `perp@${h}d`)];
    out.push(head.join("  |  "));
    out.push("-".repeat(78));
    for (const r of [...rows].sort((a, b) => b.medianCrossover - a.medianCrossover)) {
      out.push(
        [
          r.ticker.padEnd(6),
          vol(r.perpVolume24h).padStart(7),
          String(r.days).padStart(4),
          bp(r.medianDailyFunding).padStart(9),
          `${days(r.p25Crossover)} / ${days(r.medianCrossover)} / ${days(r.p75Crossover)}`.padEnd(22),
          pct(r.negativeFundingShare).padStart(5),
          ...cfg.horizons.map((h) => pct(r.perpWinShare[h]).padStart(6)),
        ].join("  |  "),
      );
    }
    out.push("");
  };

  if (scored.length > 0) {
    table(liquid, "PER TICKER (liquid enough to trade)");
    table(thin, `TOO THIN TO TRADE (perp under ${vol(cfg.minPerpQuoteVolume24h)} or rToken under ${vol(cfg.minSpotQuoteVolume24h)} in 24h, excluded from the verdict)`);
    out.push("ACROSS LIQUID TICKERS", "");
    for (const h of cfg.horizons) {
      const shares = liquid.map((r) => r.perpWinShare[h]).filter(Number.isFinite);
      const mean = shares.reduce((a, b) => a + b, 0) / (shares.length || 1);
      const flips = liquid.reduce((s, r) => s + (r.flips[h] ?? 0), 0);
      const agrees = liquid.map((r) => r.hindsightAgreement[h]).filter(Number.isFinite);
      const agree = agrees.length ? agrees.reduce((a, b) => a + b, 0) / agrees.length : NaN;
      const tag = mean >= cfg.contestedLow && mean <= cfg.contestedHigh ? "CONTESTED" : mean < cfg.contestedLow ? "rToken always" : "perp always";
      out.push(`  ${String(h).padStart(3)}d: perp cheaper on ${pct(mean).padStart(5)} of days, ${String(flips).padStart(4)} recommendation changes, hindsight agreement ${pct(agree)}   ${tag}`);
    }
    out.push("");
  }

  if (excluded.length) {
    out.push(`EXCLUDED: ${excluded.length} ticker collisions`, "");
    for (const e of excluded.slice(0, 25)) out.push(`  ${e.ticker}: ${e.reason}`);
    if (excluded.length > 25) out.push(`  ... and ${excluded.length - 25} more, see the JSON`);
    out.push("");
  }

  const failed = results.filter((r) => r.error);
  if (failed.length) {
    out.push("SKIPPED", "");
    for (const r of failed) out.push(`  ${r.ticker}: ${r.error}`);
    out.push("");
  }

  out.push("NOT MODELED", "");
  out.push("  Spreads: Bitget exposes no historical orderbook, so entry and exit spread is absent.");
  out.push("  Also absent: dividends, Stock+, collateral value, slippage, funding-cap regime changes.");
  out.push("  Volume is a 24h snapshot taken now, not over the funding window.");
  out.push("  Each of those favours the rToken, so NO-GO here is decisive and GO still needs the cost model.");
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------- selftest

function synthetic(name: string, dailyRate: number, noise: number, intervalHours: number, nDays: number, seed = 7): { pair: Pair; series: Funding[] } {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const perSettlement = dailyRate / (24 / intervalHours);
  const series: Funding[] = [];
  const start = Date.UTC(2026, 4, 1);
  const step = intervalHours * 3_600_000;
  for (let t = start; t < start + nDays * DAY_MS; t += step) {
    series.push({ ts: t, rate: perSettlement * (1 + noise * (rnd() * 2 - 1)) });
  }
  return {
    pair: {
      ticker: name,
      spotSymbol: `R${name}USDT`,
      perpSymbol: `${name}USDT`,
      fundingIntervalHours: intervalHours,
      intervalSource: "instrument",
      perpVolume24h: 5_000_000,
      spotVolume24h: 1_000_000,
      thin: false,
    },
    series,
  };
}

function selftest(): number {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
    if (!ok) failures++;
  };
  console.log("\nMath checks\n");

  // Fee gap is 0.0008. At 0.0008/day funding the crossover is exactly one day.
  check("crossover is 1 day when daily funding equals the fee gap", Math.abs(crossoverDays(0.0008, 0.002, 0.0012) - 1) < 1e-9);
  check("perp always wins when funding pays the long", crossoverDays(-0.0001, 0.002, 0.0012) === Infinity);
  check("perp always wins at zero funding", crossoverDays(0, 0.002, 0.0012) === Infinity);
  check("perp never wins when its fees are higher", crossoverDays(0.0001, 0.001, 0.0012) === 0);
  check("high funding pushes the crossover under a day", crossoverDays(0.01, 0.002, 0.0012) < 0.1, days(crossoverDays(0.01, 0.002, 0.0012)));

  const sIn = synthetic("MID", 0.0008, 0.05, 8, 120);
  const dailyIn = trailingDailyFunding(sIn.series, sIn.series[sIn.series.length - 1].ts, 7, 8)!;
  check("trailing daily funding recovers the generating rate", Math.abs(dailyIn - 0.0008) < 0.00005, bp(dailyIn));

  const realized = realizedFunding(sIn.series, sIn.series[0].ts, 10);
  check("realized funding over 10 days is about 10x the daily rate", Math.abs(realized.cost - 0.008) < 0.0008, bp(realized.cost));
  check("realized funding counts 3 settlements a day", realized.settlements === 30, String(realized.settlements));

  check("quantile handles infinities", quantile([1, 2, Infinity, Infinity], 0.5) === Infinity);
  check("quantile interpolates", quantile([0, 10], 0.5) === 5);

  console.log("\nVerdict checks\n");
  const cfg = { ...CONFIG, horizons: [1, 7, 30] };

  // Funding so high the perp loses at every horizon over a day: nothing to recommend.
  const hot = [synthetic("HOT1", 0.02, 0.1, 8, 120), synthetic("HOT2", 0.018, 0.1, 8, 120)].map((x) => analyze(x.pair, x.series, cfg));
  const vHot = verdict(hot, cfg);
  check("degenerate high funding is NO-GO", vHot.overall === "NO-GO", vHot.reasons[1]);

  // Funding near zero: the perp wins everywhere, also nothing to recommend.
  const cold = [synthetic("COLD1", 0.000002, 0.1, 8, 120), synthetic("COLD2", 0.000001, 0.1, 8, 120)].map((x) => analyze(x.pair, x.series, cfg));
  const vCold = verdict(cold, cfg);
  check("degenerate low funding is NO-GO", vCold.overall === "NO-GO", vCold.reasons[1]);

  // Funding that straddles the 7-day crossover with real variation: a live product.
  const live = [
    synthetic("LIVE1", 0.000115, 1.6, 8, 150, 3),
    synthetic("LIVE2", 0.000105, 1.7, 8, 150, 11),
    synthetic("LIVE3", 0.000125, 1.5, 8, 150, 29),
  ].map((x) => analyze(x.pair, x.series, cfg));
  const vLive = verdict(live, cfg);
  check("contested funding is GO", vLive.overall === "GO", `${vLive.contestedHorizons.join(",")}d contested`);
  check("contested case produces recommendation changes", live.some((r) => (r.flips[7] ?? 0) > 0), String(live[0].flips[7]));
  check("hindsight agreement is computed", Number.isFinite(live[0].hindsightAgreement[7]), pct(live[0].hindsightAgreement[7]));

  console.log("\nUniverse checks\n");
  const cfgU = { ...CONFIG };
  const spotRows = [
    { symbol: "RNVDAUSDT", baseCoin: "RNVDA", quoteCoin: "USDT", isReality: "yes" },
    { symbol: "RBCHUSDT", baseCoin: "RBCH", quoteCoin: "USDT", isReality: "yes" }, // Banco de Chile
    { symbol: "RTINYUSDT", baseCoin: "RTINY", quoteCoin: "USDT", isReality: "yes" },
    { symbol: "BCHUSDT", baseCoin: "BCH", quoteCoin: "USDT", isReality: "no" }, // Bitcoin Cash on spot
    { symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", isReality: "no" },
    { symbol: "RENDERUSDT", baseCoin: "RENDER", quoteCoin: "USDT", isReality: "no" },
  ];
  const perpRows = [
    { symbol: "NVDAUSDT", fundInterval: "8" },
    { symbol: "BCHUSDT", fundInterval: "8" },
    { symbol: "TINYUSDT", fundInterval: "8" },
    { symbol: "BTCUSDT", fundInterval: "8" },
  ];
  const volumes = {
    spot: new Map([["RNVDAUSDT", 4_000_000], ["RBCHUSDT", 900_000], ["RTINYUSDT", 2_000]]),
    perp: new Map([["NVDAUSDT", 30_000_000], ["BCHUSDT", 80_000_000], ["TINYUSDT", 1_000]]),
  };
  const u = buildUniverse(spotRows, perpRows, volumes, cfgU);

  check("isReality identifies rTokens and excludes lookalikes", u.rTokenCount === 3, `found ${u.rTokenCount}`);
  check("crypto collision is excluded", u.excluded.some((e) => e.ticker === "BCH") && !u.pairs.some((p) => p.ticker === "BCH"));
  check("real stock pair survives", u.pairs.some((p) => p.ticker === "NVDA"));
  check("collision filter is used when no stock marker exists", u.perpFilter === "collision");
  check("thin ticker is kept but flagged", u.pairs.find((p) => p.ticker === "TINY")?.thin === true);
  check("liquid ticker is not flagged", u.pairs.find((p) => p.ticker === "NVDA")?.thin === false);
  check("volume is attached to the pair", u.pairs.find((p) => p.ticker === "NVDA")?.perpVolume24h === 30_000_000);
  check("funding interval is read from the instrument", u.pairs[0].fundingIntervalHours === 8 && u.pairs[0].intervalSource === "instrument");

  const marked = buildUniverse(
    spotRows,
    perpRows.map((r) => ({ ...r, isReality: r.symbol === "NVDAUSDT" ? "yes" : "no" })),
    volumes,
    cfgU,
  );
  check("a stock marker on perps is ignored until it classifies enough rows", marked.perpFilter === "collision");
  check("positive stock marker is read when present", perpIsStock({ isReality: "yes" }) === true && perpIsStock({ symbolType: "CRYPTO" }) === false);
  check("unknown perp kind returns null rather than guessing", perpIsStock({ symbol: "NVDAUSDT" }) === null);

  const noFlag = extractRTokens(spotRows.map(({ isReality, ...rest }) => rest));
  check("missing isReality falls back to the R prefix and says so", noFlag.flagPresent === false && noFlag.rTokens.has("NVDA"));

  check("interval in milliseconds is converted", extractFundingInterval({ fundInterval: "28800000" }) === 8);
  check("interval in minutes is converted", extractFundingInterval({ fundInterval: "480" }) === 8);
  check("volume is read from any of the usual fields", extractVolume({ usdtVolume: "1234.5" }) === 1234.5 && extractVolume({ quoteVolume: "9" }) === 9);

  const parsed = parseFundingRows([
    { symbol: "NVDAUSDT", fundingRate: "0.0001", fundingRateTimestamp: "1754899200000" },
    { symbol: "NVDAUSDT", fundingRate: "-0.0002", fundingRateTimestamp: "1754870400000" },
    { symbol: "NVDAUSDT", fundingRate: "bad", fundingRateTimestamp: "1754870400000" },
  ]);
  check("funding rows parse and sort oldest first", parsed.length === 2 && parsed[0].ts < parsed[1].ts);
  check("junk rows are dropped", parsed.every((x) => Number.isFinite(x.rate)));
  check("rowsOf unwraps resultList", rowsOf({ resultList: [{ a: 1 }] }).length === 1);

  console.log("\nThin-filter checks\n");
  const thinPair = { ...synthetic("THIN", 0.000115, 1.6, 8, 150, 3) };
  thinPair.pair.thin = true;
  const thinOnly = [analyze(thinPair.pair, thinPair.series, cfg)];
  check("a universe of only thin tickers is NO-GO", verdict(thinOnly, cfg).overall === "NO-GO", verdict(thinOnly, cfg).reasons[0]);
  check("shortlist names the contested liquid tickers", vLive.shortlist.length === 3, vLive.shortlist.join(","));

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} checks FAILED.`}\n`);
  if (failures === 0) {
    console.log("Sample report on the contested synthetic case, so you know what a GO looks like:");
    console.log(report(live, vLive, cfg, ["Synthetic data, not Bitget."]));
  }
  return failures;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    process.exitCode = selftest() === 0 ? 0 : 1;
    return;
  }
  const num = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    if (i < 0) return fallback;
    const v = Number(argv[i + 1]);
    return Number.isFinite(v) ? v : fallback;
  };
  const cfg: Config = {
    ...CONFIG,
    spotTakerFee: num("--spot-fee", CONFIG.spotTakerFee),
    perpTakerFee: num("--perp-fee", CONFIG.perpTakerFee),
    lookbackDays: num("--lookback", CONFIG.lookbackDays),
    maxTickers: num("--max", CONFIG.maxTickers),
  };
  const meta: string[] = [];

  console.log("Pulling instruments and tickers...");
  const [spotData, perpData, spotTick, perpTick] = await Promise.all([
    getJson(`${BASE}/api/v3/market/instruments?category=SPOT`),
    getJson(`${BASE}/api/v3/market/instruments?category=USDT-FUTURES`),
    getJson(`${BASE}/api/v3/market/tickers?category=SPOT`).catch(() => null),
    getJson(`${BASE}/api/v3/market/tickers?category=USDT-FUTURES`).catch(() => null),
  ]);

  const volumeMap = (data: unknown): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rowsOf(data)) {
      const sym = str(r, "symbol").toUpperCase();
      const v = extractVolume(r);
      if (sym && v !== null) m.set(sym, v);
    }
    return m;
  };
  const volumes = { spot: volumeMap(spotTick), perp: volumeMap(perpTick) };
  if (volumes.perp.size === 0) meta.push("WARNING: no perp volume data, so nothing could be screened for thinness. Check the tickers response shape.");

  const universe = buildUniverse(rowsOf(spotData), rowsOf(perpData), volumes, cfg);
  const { pairs, excluded } = universe;
  meta.push(`${universe.rTokenCount} rTokens and ${universe.perpCount} USDT perps listed; ${pairs.length + excluded.length} tickers have both.`);
  meta.push(
    universe.realityFlagOnSpot
      ? "rTokens identified by the isReality flag."
      : "WARNING: no isReality flag on spot instruments, so rTokens were guessed from an R-prefixed base coin. The rToken count will be inflated.",
  );
  meta.push(
    universe.perpFilter === "marker"
      ? "Stock perps identified by a marker on the perp instrument."
      : "WARNING: no stock marker on perp instruments, so crypto collisions were removed by checking whether the ticker is also a spot crypto.",
  );
  if (excluded.length) meta.push(`${excluded.length} tickers dropped as crypto collisions, for example ${excluded.slice(0, 3).map((e) => e.ticker).join(", ")}.`);
  const thinCount = pairs.filter((p) => p.thin).length;
  if (thinCount) meta.push(`${thinCount} of ${pairs.length} remaining perps are below the volume floor and are reported separately.`);
  console.log(meta.join("\n"));
  if (pairs.length === 0) throw new Error("No ticker survived. Check the instruments response shape.");
  const assumed = pairs.filter((p) => p.intervalSource === "assumed").length;
  if (assumed) meta.push(`${assumed} tickers had no funding interval in the instrument response; 8 hours assumed for those.`);

  const selected = cfg.maxTickers > 0 ? pairs.slice(0, cfg.maxTickers) : pairs;
  const sinceMs = Date.now() - cfg.lookbackDays * DAY_MS;
  const results: TickerResult[] = [];
  let sources = new Set<string>();
  for (let i = 0; i < selected.length; i++) {
    const p = selected[i];
    process.stdout.write(`\r  funding ${i + 1}/${selected.length}  ${p.ticker.padEnd(8)}`);
    try {
      const { series, source } = await fetchFunding(p.perpSymbol, sinceMs);
      sources.add(source);
      results.push(analyze(p, series, cfg));
    } catch (e) {
      results.push({ ...analyze(p, [], cfg), error: (e as Error).message });
    }
  }
  process.stdout.write("\r" + " ".repeat(40) + "\r");
  meta.push(`Funding history from the ${[...sources].join(" and ")} endpoint, ${cfg.lookbackDays}-day lookback, ${cfg.trailingDays}-day trailing estimator.`);

  const v = verdict(results, cfg);
  const text = report(results, v, cfg, meta, excluded);
  console.log(text);
  const { writeFileSync } = await import("node:fs");
  writeFileSync("flip-test-report.txt", text);
  writeFileSync("flip-test-raw.json", JSON.stringify({ generatedAt: new Date().toISOString(), config: cfg, verdict: v, universe: { rTokenCount: universe.rTokenCount, perpCount: universe.perpCount, realityFlagOnSpot: universe.realityFlagOnSpot, perpFilter: universe.perpFilter, excluded }, results }, null, 2));
  console.log("Wrote flip-test-report.txt and flip-test-raw.json");
  process.exitCode = v.overall === "GO" ? 0 : 2;
}

const entry = process.argv[1] ?? "";
if (/flip-test\.(ts|js|mjs)$/.test(entry)) {
  main().catch((e) => {
    console.error(`\nError: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
