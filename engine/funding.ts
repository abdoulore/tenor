/**
 * Funding projection for the perp leg.
 *
 * The flip test measured hindsight agreement of 65 to 82% for a trailing estimator, so a
 * point estimate would be dishonest. Everything here returns a range.
 *
 * Reused from canary/flip-test.ts: the trailing estimator and the quantile helper. The
 * conclusion that stock perp funding is zero most of the time and spikes is the flip test's,
 * and this projects that behaviour forward rather than assuming a smooth rate.
 */

import type { Range } from "./types.ts";

export interface Settlement {
  ts: number;
  rate: number;
}

const DAY_MS = 86_400_000;

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Daily funding rate implied by the trailing window, using only settlements before `atMs`.
 * Returns null when the window holds no settlements, which is a real state on a newly
 * listed perp and must not be silently treated as zero funding.
 */
export function trailingDailyFunding(
  series: Settlement[],
  atMs: number,
  windowDays: number,
  intervalHours: number,
): number | null {
  const from = atMs - windowDays * DAY_MS;
  const window = series.filter((s) => s.ts >= from && s.ts < atMs);
  if (!window.length) return null;
  const perDay = 24 / intervalHours;
  const mean = window.reduce((t, s) => t + s.rate, 0) / window.length;
  return mean * perDay;
}

/** Daily funding totals, one per calendar day, over the trailing window. */
export function dailyTotals(series: Settlement[], atMs: number, windowDays: number): number[] {
  const from = atMs - windowDays * DAY_MS;
  const byDay = new Map<number, number>();
  for (const s of series) {
    if (s.ts < from || s.ts >= atMs) continue;
    const day = Math.floor(s.ts / DAY_MS);
    byDay.set(day, (byDay.get(day) ?? 0) + s.rate);
  }
  return [...byDay.values()];
}

export interface FundingProjection {
  /** Cost in bp over the horizon for a long. A short receives it, so the sign flips. */
  bp: Range;
  dailyBp: Range;
  settlements: number;
  windowDays: number;
  /** True when the estimator had nothing to work with. */
  missing: boolean;
}

/**
 * Project funding over a horizon.
 *
 * Centre is the trailing 7 day estimate, which is what the flip test validated.
 *
 * The band is the 10th to 90th percentile of daily funding over the trailing 30 days, not
 * the quartiles. The flip test found stock perp funding is zero most of the time and spikes,
 * and on a distribution that is zero four days in five a p25/p75 band collapses to zero and
 * reports no uncertainty at all. That is precisely backwards: the rare spike is the entire
 * risk being projected. A decile band still catches a move that shows up on a fifth of days.
 *
 * The band is widened to include the centre, because a quiet week inside a volatile month
 * should not produce a range that excludes its own estimate.
 */
export function projectFunding(
  series: Settlement[],
  horizonDays: number,
  direction: "long" | "short",
  opts: { atMs?: number; intervalHours?: number; trailingDays?: number; bandDays?: number } = {},
): FundingProjection {
  const atMs = opts.atMs ?? Date.now();
  const intervalHours = opts.intervalHours ?? 8;
  const trailingDays = opts.trailingDays ?? 7;
  const bandDays = opts.bandDays ?? 30;

  const centreDaily = trailingDailyFunding(series, atMs, trailingDays, intervalHours);
  const totals = dailyTotals(series, atMs, bandDays);

  if (centreDaily === null && !totals.length) {
    const zero = { low: 0, mid: 0, high: 0 };
    return { bp: zero, dailyBp: zero, settlements: 0, windowDays: trailingDays, missing: true };
  }

  const centre = centreDaily ?? 0;
  let low = totals.length ? quantile(totals, 0.10) : centre;
  let high = totals.length ? quantile(totals, 0.90) : centre;
  low = Math.min(low, centre);
  high = Math.max(high, centre);

  // A long pays positive funding, a short receives it.
  const sign = direction === "long" ? 1 : -1;
  const dailyBp = ordered(sign * low * 10_000, sign * centre * 10_000, sign * high * 10_000);

  return {
    bp: {
      low: round(dailyBp.low * horizonDays, 4),
      mid: round(dailyBp.mid * horizonDays, 4),
      high: round(dailyBp.high * horizonDays, 4),
    },
    dailyBp: { low: round(dailyBp.low, 6), mid: round(dailyBp.mid, 6), high: round(dailyBp.high, 6) },
    settlements: series.filter((s) => s.ts >= atMs - bandDays * DAY_MS && s.ts < atMs).length,
    windowDays: trailingDays,
    missing: centreDaily === null,
  };
}

/** Flipping the sign for a short can invert low and high, so re-sort. */
function ordered(a: number, b: number, c: number): Range {
  const [low, mid, high] = [a, b, c].sort((x, y) => x - y);
  return { low, mid, high };
}

/**
 * The horizon at which a per-day cost closes a fixed up front gap, in days.
 * Reused from canary/flip-test.ts crossoverDays. Infinity means it never closes.
 */
export function crossoverDays(dailyCostBp: number, upfrontGapBp: number): number {
  if (!Number.isFinite(dailyCostBp) || dailyCostBp <= 0) return Infinity;
  return upfrontGapBp / dailyCostBp;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
