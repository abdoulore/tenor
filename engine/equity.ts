/**
 * What the underlying share adds to the picture.
 *
 * Data comes from Bitget's own market data service (bitget-mcp-server), which carries the real
 * share price, past dividends and past earnings dates for US stocks. Three things follow from
 * it, and each is labelled for what it is:
 *
 *   premium    the tokenized stock's price against the real share price, measured now
 *   dividend   the next payment, projected from the company's past payment rhythm
 *   earnings   the next report, projected the same way
 *
 * Nothing here is announced or guaranteed. The service returns history, not a forward
 * calendar, so a future date is a projection and the page says so every time.
 */

const DAY_MS = 86_400_000;

export interface Projection {
  /** ISO date. Projected unless `announced` is set. */
  date: string;
  /** True when the date is in the data as an upcoming event rather than worked out. */
  announced?: boolean;
  /** How many past dates the rhythm was worked out from. */
  basedOn: number;
  /** The typical gap between past dates, in days. */
  intervalDays: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Project the next date in a regular series, such as quarterly dividends or earnings.
 *
 * Needs at least three past dates, so there are at least two gaps to take a typical gap from.
 * Irregular series, where the gaps disagree by more than a third, are not projected at all,
 * because a guess dressed as a date is worse than no date.
 */
export function projectNext(pastIsoDates: string[], nowMs: number): Projection | null {
  const sorted = [...new Set(pastIsoDates)]
    .map((d) => Date.parse(d.length === 10 ? `${d}T00:00:00Z` : d))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  /*
   * One event can appear as several dates a few days apart: a preliminary announcement and the
   * full report, for example. Left in, they read as a one day rhythm. Anything within ten days of
   * the previous kept date is treated as the same event.
   */
  const times: number[] = [];
  for (const t of sorted) {
    if (!times.length || t - times[times.length - 1] > 10 * DAY_MS) times.push(t);
  }
  if (times.length < 3) return null;

  const recent = times.slice(-5);
  const gaps: number[] = [];
  for (let i = 1; i < recent.length; i++) gaps.push((recent[i] - recent[i - 1]) / DAY_MS);
  const typical = median(gaps);
  if (!(typical > 20)) return null;
  if (gaps.some((g) => Math.abs(g - typical) > typical / 3)) return null;

  let next = recent[recent.length - 1] + typical * DAY_MS;
  while (next <= nowMs) next += typical * DAY_MS;

  return {
    date: new Date(next).toISOString().slice(0, 10),
    basedOn: recent.length,
    intervalDays: Math.round(typical),
  };
}

/** Whether a projected date falls inside the holding period that starts now. */
export function withinHorizon(p: Projection | null, nowMs: number, horizonDays: number): boolean {
  if (!p) return false;
  const t = Date.parse(`${p.date}T00:00:00Z`);
  return t >= nowMs - DAY_MS && t <= nowMs + horizonDays * DAY_MS;
}

/**
 * The tokenized stock's price against the share price, in basis points. Positive means the token
 * costs more than the share. Null when either price is missing.
 */
export function premiumBp(tokenMid: number | null | undefined, sharePrice: number | null | undefined): number | null {
  if (!tokenMid || !sharePrice || !(tokenMid > 0) || !(sharePrice > 0)) return null;
  return Math.round(((tokenMid - sharePrice) / sharePrice) * 10_000 * 10) / 10;
}

/** A per-share dividend as a percentage of the share price. */
export function dividendYieldPct(amountPerShare: number | null | undefined, sharePrice: number | null | undefined): number | null {
  if (!amountPerShare || !sharePrice || !(amountPerShare > 0) || !(sharePrice > 0)) return null;
  return Math.round((amountPerShare / sharePrice) * 100 * 1000) / 1000;
}

export interface ShareFacts {
  symbol: string;
  /** Real share price from the market data service, and when it was read. */
  price: { last: number; prevClose: number | null } | null;
  dividends: { exDate: string; amount: number }[];
  /** Past report dates, newest first. */
  earnings: string[];
  source: string;
}

export interface ShareOutlook {
  premiumBp: number | null;
  nextDividend: (Projection & { amount: number; yieldPct: number | null; inHorizon: boolean }) | null;
  nextEarnings: (Projection & { inHorizon: boolean }) | null;
}

/**
 * Dates the service returns are not all trustworthy: KO's dividend history contains an ex-date
 * in the year 2152. Anything more than 120 days out, or before 1990, is treated as a data error
 * and dropped. A date a little ahead of today is kept, and reported as announced rather than
 * projected, because that is what it is.
 */
const ANNOUNCED_WINDOW_DAYS = 120;
function plausible(iso: string, nowMs: number): boolean {
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isFinite(t) && t >= Date.parse("1990-01-01T00:00:00Z") && t <= nowMs + ANNOUNCED_WINDOW_DAYS * DAY_MS;
}
const at = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

/** The earliest announced date after today, or a projection from past dates, or nothing. */
function nextEvent(dates: string[], nowMs: number): Projection | null {
  const ok = dates.filter((d) => plausible(d, nowMs));
  const upcoming = ok.filter((d) => at(d) > nowMs).sort()[0];
  const past = ok.filter((d) => at(d) <= nowMs);
  const proj = projectNext(past, nowMs);
  if (upcoming) {
    return { date: upcoming.slice(0, 10), announced: true, basedOn: 0, intervalDays: proj?.intervalDays ?? 0 };
  }
  return proj;
}

/** Everything the page says about the underlying share, worked out from the facts. */
export function shareOutlook(facts: ShareFacts, tokenMid: number | null, nowMs: number, horizonDays: number): ShareOutlook {
  const price = facts.price?.last ?? null;

  const divs = facts.dividends.filter((d) => plausible(d.exDate, nowMs));
  const divProj = nextEvent(divs.map((d) => d.exDate), nowMs);
  // The amount comes from the most recent payment that has actually happened, or the announced
  // one if that is what the date refers to.
  const byDate = [...divs].sort((a, b) => (a.exDate < b.exDate ? 1 : -1));
  const lastAmount = divProj?.announced
    ? byDate.find((d) => d.exDate.slice(0, 10) === divProj.date)?.amount ?? null
    : byDate.find((d) => at(d.exDate) <= nowMs)?.amount ?? null;

  const earnProj = nextEvent(facts.earnings, nowMs);

  return {
    premiumBp: premiumBp(tokenMid, price),
    nextDividend: divProj && lastAmount
      ? {
          ...divProj,
          amount: lastAmount,
          yieldPct: dividendYieldPct(lastAmount, price),
          inHorizon: withinHorizon(divProj, nowMs, horizonDays),
        }
      : null,
    nextEarnings: earnProj ? { ...earnProj, inHorizon: withinHorizon(earnProj, nowMs, horizonDays) } : null,
  };
}
