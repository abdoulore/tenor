/**
 * Universe resolution for the spread sampler.
 *
 * Ported from canary/flip-test.ts buildUniverse. Same rToken detection, same crypto
 * collision filter, same volume floors, so the sampler measures exactly the tickers
 * the flip test scored. Kept dependency free and in plain .mjs on purpose.
 */

export const BASE = "https://api.bitget.com";

// The 88 tickers the flip test judged liquid enough to trade. Used only to reconcile
// against the live universe and report drift, never to override it.
export const CANARY_LIQUID = "AAOI AAPL ABNB AMAT AMD AMZN APLD APP ARM ASML ASTS AVAV AVGO AXTI BABA BE BMNR CBRS COHR COIN CONL COP CRCL CRDO CRWD CRWV DDOG DELL DRAM ETN EWY FLY GLW GOOGL GTLB HOOD HPE IBM INTC IONQ IREN KWEB LITE LLY MARA META MRNA MRVL MSFT MSTR MSTU MU MVLL NBIS NET NKE NOW NVDA OKLO ORCL PANW PLTR PURR QCOM QQQ RAM RDDT RKLB SKHY SMCI SNDK SNXX SOXL SOXS SOXX SPCX SPY SQQQ STRC TEAM TEM TQQQ TSLA TSM USAR UVXY WDC ZS".split(" ");

// Thin names carried as a control group. If rToken depth is bad everywhere and not just
// on thin names, that is a different finding than if it tracks volume.
export const CONTROL_THIN = ["OKTA", "FUTU", "KO", "GE", "UBER", "ALAB", "NFLX", "CRM"];

export const MIN_PERP_QUOTE_VOL_24H = 250_000;
export const MIN_SPOT_QUOTE_VOL_24H = 50_000;

const str = (r, ...keys) => {
  for (const k of keys) {
    const v = r?.[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return "";
};

export function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const k of ["list", "resultList", "items", "rows", "data"]) {
      if (Array.isArray(data[k])) return data[k];
    }
  }
  return [];
}

export function extractRTokens(rows) {
  const rTokens = new Map();
  const flagPresent = rows.some((r) => str(r, "isReality", "isRwa") !== "");
  for (const r of rows) {
    const symbol = str(r, "symbol");
    const base = str(r, "baseCoin", "baseCurrency").toUpperCase();
    const quote = str(r, "quoteCoin", "quoteCurrency").toUpperCase();
    const reality = str(r, "isReality", "isRwa").toLowerCase();
    if (!symbol || quote !== "USDT") continue;
    const isR = flagPresent ? reality === "yes" : /^R[A-Z]{1,6}$/.test(base);
    if (!isR) continue;
    const ticker = base.replace(/^R/i, "").toUpperCase();
    if (!ticker) continue;
    if (!rTokens.has(ticker)) rTokens.set(ticker, symbol);
  }
  return { rTokens, flagPresent };
}

export function cryptoSpotBases(rows, flagPresent) {
  const out = new Set();
  for (const r of rows) {
    const base = str(r, "baseCoin", "baseCurrency").toUpperCase();
    if (!base) continue;
    const reality = str(r, "isReality", "isRwa").toLowerCase();
    const isR = flagPresent ? reality === "yes" : /^R[A-Z]{1,6}$/.test(base);
    if (!isR) out.add(base);
  }
  return out;
}

/**
 * A positive stock marker on the perp instrument.
 *
 * Bitget now ships two fields the flip test did not see: isRwa, and a symbolType that
 * reads stock, commodity or crypto. That changes the universe in both directions.
 *
 * Excluded: commodities. CLUSDT and BZUSDT are crude oil, not Colgate, and isRwa is YES
 * on both. A stock wrapper product has nothing to say about them.
 *
 * Recovered: tickers the flip test dropped as crypto collisions that are in fact stocks.
 * RIOUSDT, VALEUSDT and HPQUSDT carry isRwa=YES with symbolType=crypto, which looks like
 * a mislabel on Bitget's side, but isRwa is the field that settles it. BCHUSDT, TUSDT and
 * DASHUSDT are isRwa=NO and stay excluded, which is the answer the flip test wanted.
 */
export function perpIsStock(r) {
  const kind = str(r, "symbolType", "instType", "assetType", "underlyingType", "businessType").toUpperCase();
  if (/COMMODITY|FOREX|FX|INDEX/.test(kind)) return false;
  if (/STOCK|EQUITY|TRADFI|REALITY/.test(kind)) return true;

  const flag = str(r, "isReality", "isRwa").toLowerCase();
  if (flag === "yes") return true;
  if (flag === "no") return false;
  if (/CRYPTO|COIN|DIGITAL/.test(kind)) return false;
  return null;
}

/**
 * 24h quote volume. The v3 tickers endpoint calls it turnover24h.
 *
 * For an rToken, turnover24h carries the underlying's global figure and runs into the
 * billions, so screening the rToken leg on it passes everything and the 50K spot floor in
 * the flip test never bound. platformTurnover24h is Bitget's own book and is the number
 * that decides whether the rToken leg is tradeable. Both are recorded per pair.
 */
export function extractVolume(r) {
  const raw = str(r, "usdtVolume", "quoteVolume", "turnover24h", "quoteVol", "volumeUsdt", "usdtVol");
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function extractPlatformVolume(r) {
  const raw = str(r, "platformTurnover24h");
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function buildUniverse(spotRows, perpRows, volumes) {
  const { rTokens, flagPresent } = extractRTokens(spotRows);
  const cryptoBases = cryptoSpotBases(spotRows, flagPresent);

  const perps = new Map();
  let marked = 0;
  for (const r of perpRows) {
    const symbol = str(r, "symbol").toUpperCase();
    if (!symbol) continue;
    perps.set(symbol, r);
    if (perpIsStock(r) === true) marked++;
  }
  const perpFilter = marked >= 20 ? "marker" : "collision";

  const pairs = [];
  const excluded = [];
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
      excluded.push({ ticker, reason: `${ticker} is also a crypto listed on spot` });
      continue;
    }

    const perpVolume24h = volumes.perp.get(perpSymbol) ?? null;
    const spotVolume24h = volumes.spot.get(spotSymbol.toUpperCase()) ?? null;
    const spotPlatformVolume24h = volumes.spotPlatform.get(spotSymbol.toUpperCase()) ?? null;

    // The screen is kept identical to the flip test so the sampled set stays comparable to
    // the scored set. spotPlatformVolume24h is recorded but deliberately not screened on
    // yet, because changing the floor now would silently change the universe mid study.
    const thin =
      (perpVolume24h !== null && perpVolume24h < MIN_PERP_QUOTE_VOL_24H) ||
      (spotVolume24h !== null && spotVolume24h < MIN_SPOT_QUOTE_VOL_24H);

    pairs.push({
      ticker,
      spotSymbol,
      perpSymbol: str(row, "symbol"),
      symbolType: str(row, "symbolType"),
      isRwa: str(row, "isRwa"),
      perpVolume24h,
      spotVolume24h,
      spotPlatformVolume24h,
      thin,
    });
  }
  pairs.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return { pairs, excluded, rTokenCount: rTokens.size, perpCount: perps.size, realityFlagOnSpot: flagPresent, perpFilter };
}
