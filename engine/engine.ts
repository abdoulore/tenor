/**
 * The Tenor cost engine.
 *
 * Four gates, in order. The first two decide, the last two adjust.
 *
 *   1. Can you trade it at all?   No book means untradeable, not expensive.
 *   2. At your size?              Walk the book for the requested notional.
 *   3. At this hour?              Session adjusted, naming a better session when there is one.
 *   4. For how long?              Only when execution is inside the fee gap.
 *
 * Deterministic throughout. No model touches any number here.
 */

import { absorbable, execution, isEmpty } from "./book.ts";
import { DEFAULT_FEES, feeCaveats, feeGapBp, feeLegFor, roundTripFeeBp, unverifiedLegs, type FeeSchedule } from "./fees.ts";
import { checkEligibility, ROUTE_LABELS } from "./eligibility.ts";
import { projectFunding, type Settlement } from "./funding.ts";
import type {
  Book, Intent, Quote, Range, RouteId, RouteResult, Session, SessionOutlook,
} from "./types.ts";

export interface PricingInputs {
  session: Session;
  /** Live books per route. A route absent from the map is treated as having no book. */
  books: Partial<Record<RouteId, Book>>;
  /** Perp funding settlements, newest last. */
  funding?: Settlement[];
  fundingIntervalHours?: number;
  fees?: FeeSchedule;
  /** Per route session medians from the sampler, for the session chart and gate 3. */
  outlook?: Record<RouteId, SessionOutlook[]>;
  /** Routes priced from a stored snapshot rather than a live book, with the snapshot age. */
  stalenessMs?: Partial<Record<RouteId, number>>;
  /**
   * Replace the live book's execution cost with a measured figure, used to answer "what
   * would this cost at a different hour". The session label alone changes only eligibility,
   * so asking about another session without this would re-price the current book and report
   * the current number under a different name.
   */
  executionBpOverride?: Partial<Record<RouteId, number | null>>;
  now?: number;
}

const ROUTES: RouteId[] = ["rtoken", "perp", "stockplus"];

export function priceIntent(intent: Intent, inputs: PricingInputs): Quote {
  const fees = inputs.fees ?? DEFAULT_FEES;
  const now = inputs.now ?? Date.now();
  const warnings: string[] = [];
  const results: RouteResult[] = [];

  for (const route of ROUTES) {
    results.push(priceRoute(route, intent, inputs, fees, now, warnings));
  }

  // Rank only routes that produced a total. Ties break toward the lower ceiling, because a
  // route whose worst case is better is the safer recommendation at equal expected cost.
  /*
   * A stale route is still a tradeable route. Excluding it from the ranking made
   * `recommended` null while the cards below still showed real prices, so the page claimed
   * nothing could be traded and then priced two things. Staleness is a caveat on a number,
   * not a reason to withhold the answer.
   */
  const priced = results.filter((r) => (r.status === "ok" || r.status === "stale") && r.totalBp !== null);
  priced.sort((a, b) => a.totalBp!.mid - b.totalBp!.mid || a.totalBp!.high - b.totalBp!.high);
  priced.forEach((r, i) => { r.rank = i + 1; });

  const recommended = priced.length ? priced[0].route : null;
  if (!recommended) warnings.push("None of the three ways to hold this will work for what you asked.");

  const horizonDecides = decidesOnHorizon(results, fees);

  // A leg still on a published rate may be priced too expensive. A leg measured from fills
  // may still carry a caveat, which is a different thing and is said differently.
  const unverified = unverifiedLegs(fees);
  if (unverified.length) {
    warnings.push(
      `We have not confirmed the real trading fee for ${unverified.join(" and ")} on this account, ` +
      `so we used Bitget's published rate. The true cost may be lower.`,
    );
  }
  for (const c of feeCaveats(fees)) if (!warnings.includes(c)) warnings.push(c);

  return {
    intent,
    session: inputs.session,
    at: new Date(now).toISOString(),
    routes: results,
    recommended,
    horizonDecides,
    outlook: inputs.outlook ?? null,
    warnings,
  };
}

function priceRoute(
  route: RouteId,
  intent: Intent,
  inputs: PricingInputs,
  fees: FeeSchedule,
  now: number,
  warnings: string[],
): RouteResult {
  const base: RouteResult = {
    route,
    label: ROUTE_LABELS[route],
    status: "ok",
    reason: null,
    modeled: route === "stockplus",
    execution: null,
    absorbableUsd: null,
    feeBp: null,
    feeProvenance: null,
    feeSource: null,
    executionBp: null,
    fundingBp: null,
    totalBp: null,
    stalenessMs: inputs.stalenessMs?.[route] ?? null,
    rank: null,
  };

  // Gate 0: can this route express the view at all.
  const elig = checkEligibility(route, intent.direction, intent.constraints, inputs.session);
  for (const u of elig.unverified) if (!warnings.includes(u)) warnings.push(u);
  if (!elig.eligible) {
    return { ...base, status: "ineligible", reason: elig.reason };
  }

  const book = inputs.books[route];
  const override = inputs.executionBpOverride?.[route];
  const hasOverride = override !== undefined;

  /*
   * A counterfactual session with no measured execution for this route is unanswerable.
   * Saying "no book" would be a claim the data does not support, and falling back to the
   * current book would answer a different question, so it reports the gap as a gap.
   */
  if (hasOverride && override === null) {
    return {
      ...base,
      status: "no_book",
      reason: `Every time we checked at this hour, nobody was quoting a price for the ${ROUTE_LABELS[route].toLowerCase()}.`,
      absorbableUsd: 0,
    };
  }

  /*
   * Stock+ runs through a separate securities sub-account with no confirmed API, so there is
   * no book to walk. Its fee is published and real, its execution cost is unknown.
   *
   * Pricing it on fees alone would make it the cheapest route on the board every single
   * time, purely because the expensive half is missing. So it reports what is known, states
   * what is not, and is kept out of the ranking entirely rather than competing on a total
   * that omits execution.
   */
  if (route === "stockplus" && !book) {
    return {
      ...base,
      status: "modeled",
      feeBp: round(roundTripFeeBp(route, fees), 4),
      feeProvenance: feeLegFor(route, fees).provenance,
      feeSource: feeLegFor(route, fees).source,
      reason:
        "Bitget does not publish live prices for Stock+, so we cannot tell you what it would really cost " +
        "and we will not guess. Its fee alone is " +
        `${(round(roundTripFeeBp(route, fees), 2) / 100).toFixed(3)}% to buy and sell.`,
    };
  }

  // Gate 1: is there a book at all. This is the headline state, not an error.
  // A measured override answers for a different hour, so the current book not existing is
  // not the question being asked and does not decide it.
  if (!hasOverride && (!book || isEmpty(book))) {
    return {
      ...base,
      status: "no_book",
      reason: `Nobody is quoting a price for the ${ROUTE_LABELS[route].toLowerCase()} right now, so you could not buy or sell it at any amount.`,
      absorbableUsd: 0,
    };
  }

  // Gate 2: can it absorb the requested size.
  const exec = book && !isEmpty(book) ? execution(book, intent.notionalUsd, intent.direction) : null;
  if (!exec && !hasOverride) {
    return {
      ...base,
      status: "no_book",
      reason: `The prices quoted for the ${ROUTE_LABELS[route].toLowerCase()} do not make sense, so we will not price it.`,
      absorbableUsd: 0,
    };
  }
  if (exec && exec.roundTripBp === null && !hasOverride) {
    const canTake = absorbable(book!);
    return {
      ...base,
      status: "cannot_fill",
      execution: exec,
      absorbableUsd: canTake,
      reason:
        `Only about $${canTake.toLocaleString()} of the ${ROUTE_LABELS[route].toLowerCase()} is on offer, ` +
        `and you asked for $${intent.notionalUsd.toLocaleString()}. You would move the price against yourself.`,
    };
  }

  const feeBp = roundTripFeeBp(route, fees);
  const executionBp = hasOverride ? (override as number) : exec!.roundTripBp!;

  // Gate 4: funding, perp only, always a range.
  let fundingBp: Range | null = null;
  if (route === "perp") {
    const proj = projectFunding(inputs.funding ?? [], intent.horizonDays, intent.direction, {
      atMs: now,
      intervalHours: inputs.fundingIntervalHours ?? 8,
    });
    fundingBp = proj.bp;
    if (proj.missing) {
      const w = "This contract has no holding-fee history yet, so we show the holding cost as zero. The real figure can only be higher.";
      if (!warnings.includes(w)) warnings.push(w);
    }
  } else {
    fundingBp = { low: 0, mid: 0, high: 0 };
  }

  const fixed = feeBp + executionBp;
  const totalBp: Range = {
    low: round(fixed + fundingBp.low, 4),
    mid: round(fixed + fundingBp.mid, 4),
    high: round(fixed + fundingBp.high, 4),
  };

  const stale = base.stalenessMs !== null && base.stalenessMs > 120_000;
  return {
    ...base,
    status: stale ? "stale" : "ok",
    reason: stale
      ? `Bitget did not answer just now, so this uses prices from ${Math.round(base.stalenessMs! / 1000)} seconds ago.`
      : null,
    execution: exec,
    absorbableUsd: book && !isEmpty(book) ? absorbable(book) : null,
    feeBp: round(feeBp, 4),
    feeProvenance: feeLegFor(route, fees).provenance,
    feeSource: feeLegFor(route, fees).source,
    executionBp: round(executionBp, 4),
    fundingBp,
    totalBp,
  };
}

/**
 * Does the holding period actually decide anything.
 *
 * Only when the execution gap between the two live routes is inside the fee gap. If one
 * route costs 30bp more to get into than the other, no plausible funding path over a normal
 * horizon closes that, and showing a break-even curve would imply a decision that is not
 * really open. On the account's real rates the fee gap is 4bp toward the rToken, so the
 * comparison uses its magnitude.
 */
export function decidesOnHorizon(results: RouteResult[], fees: FeeSchedule): boolean {
  const rtoken = results.find((r) => r.route === "rtoken");
  const perp = results.find((r) => r.route === "perp");
  if (!rtoken || !perp) return false;
  if (rtoken.executionBp === null || perp.executionBp === null) return false;
  const gap = Math.abs(rtoken.executionBp - perp.executionBp);
  return gap <= Math.max(Math.abs(feeGapBp(fees)), 1e-9);
}

/**
 * Gate 3: given the session outlook, is there a cheaper session than this one.
 * Returns null when the current session is already the best, or when there is no data.
 */
export function betterSession(
  outlook: SessionOutlook[] | undefined,
  current: Session,
  /**
   * Below this, a session difference is not advice. Saving 0.39bp on $2,000 is eight cents,
   * and presenting that as a recommendation spends the user's attention on nothing.
   */
  minSavingBp = 1,
): { session: Session; executionBp: number; savingBp: number } | null {
  if (!outlook?.length) return null;
  const here = outlook.find((o) => o.session === current);
  if (!here || here.executionBp === null) return null;

  // The cheapest session available, not merely a cheaper one.
  let best: SessionOutlook | null = null;
  for (const o of outlook) {
    if (o.session === current || o.executionBp === null) continue;
    if (o.emptyShare === 1) continue; // a session with no book is not somewhere to go
    if (!best || o.executionBp < best.executionBp!) best = o;
  }
  if (!best || best.executionBp === null) return null;

  const saving = here.executionBp - best.executionBp;
  if (saving < minSavingBp) return null;
  return { session: best.session, executionBp: best.executionBp, savingBp: round(saving, 4) };
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
