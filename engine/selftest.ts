#!/usr/bin/env node
/**
 * Offline test suite for the cost engine. No network, in the flip test's selftest style.
 *
 *   node engine/selftest.ts
 *
 * Covers the degenerate cases the plan names: empty book, partial fill, zero funding,
 * negative funding, missing data, and every route ineligible.
 */

import { execution, quoteBook, toBook } from "./book.ts";
import { QUOTE_TESTS, fillGaps } from "./evidence.ts";
import { ACCOUNT_FEES, FILL_RECEIPTS, FLIP_TEST_FEES, PUBLISHED_FEES, feeGapBp, roundTripFeeBp, unverifiedLegs } from "./fees.ts";
import { checkEligibility } from "./eligibility.ts";
import { crossoverDays, projectFunding, quantile, trailingDailyFunding, type Settlement } from "./funding.ts";
import { betterSession, priceIntent } from "./engine.ts";
import { predictionFile, toRecord } from "./predictions.ts";
import { analysePosition, daysRemaining, type Position } from "./monitor.ts";
import { planSplit } from "./split.ts";
import { dividendYieldPct, premiumBp, projectNext, shareOutlook, withinHorizon } from "./equity.ts";
import { factSheet, plainText, sessionHoursIn, ungroundedNumbers } from "./grounding.ts";
import { DEFAULT_CONSTRAINTS, type Book, type Intent, type SessionOutlook } from "./types.ts";

let failures = 0;
let checks = 0;
const group = (name: string) => console.log(`\n${name}`);
function check(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (cond) console.log(`  pass  ${name}`);
  else { console.log(`  FAIL  ${name} ${detail}`); failures++; }
}
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-16T15:00:00Z");

/** A book of `levels` steps, `qtyPerLevel` units each, centred on 100 with `spreadBp`. */
function makeBook(spreadBp: number, qtyPerLevel: number, levelCount = 20): Book {
  const mid = 100;
  const half = (mid * spreadBp) / 2 / 10_000;
  const asks: [number, number][] = [];
  const bids: [number, number][] = [];
  for (let i = 0; i < levelCount; i++) {
    asks.push([mid + half + i * 0.01, qtyPerLevel]);
    bids.push([mid - half - i * 0.01, qtyPerLevel]);
  }
  return { asks, bids, ts: NOW };
}

const EMPTY_BOOK: Book = { asks: [], bids: [], ts: NOW };

function intent(over: Partial<Intent> = {}): Intent {
  return {
    ticker: "NVDA",
    notionalUsd: 2_000,
    direction: "long",
    horizonDays: 30,
    constraints: { ...DEFAULT_CONSTRAINTS },
    ...over,
  };
}

/** Settlements every 8h for `days`, each at `rate`. */
function settlements(days: number, rate: number, endMs = NOW): Settlement[] {
  const out: Settlement[] = [];
  for (let t = endMs - days * DAY; t < endMs; t += DAY / 3) out.push({ ts: t, rate });
  return out;
}

// ---------------------------------------------------------------- fees

group("fees");
check("account spot round trip is 7.90bp", near(roundTripFeeBp("rtoken", ACCOUNT_FEES), 7.8963, 1e-3),
  `got ${roundTripFeeBp("rtoken", ACCOUNT_FEES)}`);
check("account perp round trip is 12bp", near(roundTripFeeBp("perp", ACCOUNT_FEES), 12));
check("flip test spot round trip was 20bp", near(roundTripFeeBp("rtoken", FLIP_TEST_FEES), 20));
check("flip test fee gap was 8bp toward the perp", near(feeGapBp(FLIP_TEST_FEES), 8));
// 4.1037bp exactly, which is the 4.10bp the measured rates give to two decimal places.
check("account fee gap is 4.10bp toward the rToken", near(feeGapBp(ACCOUNT_FEES), -4.10, 5e-3),
  `got ${feeGapBp(ACCOUNT_FEES)}`);

// Spot and perp tiers are independent on Bitget. Nothing may infer one from the other.
check("perp is measured, not published", ACCOUNT_FEES.perp.provenance === "measured");
check("spot is measured, not published", ACCOUNT_FEES.spot.provenance === "measured");
check("perp is no longer flagged unverified", !unverifiedLegs(ACCOUNT_FEES).includes("perp"));
check("Stock+ is still flagged unverified", unverifiedLegs(ACCOUNT_FEES).includes("stockplus"));
check("perp carries no caveat", ACCOUNT_FEES.perp.caveat === undefined);
check("spot still carries the BGB caveat", /BGB/.test(ACCOUNT_FEES.spot.caveat ?? ""));
check("the account perp rate equals the published perp rate",
  ACCOUNT_FEES.perp.taker === PUBLISHED_FEES.perp.taker);
check("the account spot rate does not equal the published spot rate",
  ACCOUNT_FEES.spot.taker !== PUBLISHED_FEES.spot.taker);
check("published schedule is unmeasured throughout", unverifiedLegs(PUBLISHED_FEES).length === 3);

// Every fee constant must trace to a receipt.
const perpReceipts = FILL_RECEIPTS.filter((r) => r.venue === "perp");
check("four perp fills are recorded", perpReceipts.length === 4, `${perpReceipts.length}`);
check("every perp fill implies exactly 0.06%",
  perpReceipts.every((r) => near(r.impliedRate, 0.0006, 1e-12)),
  perpReceipts.map((r) => r.impliedRate).join(" "));
check("perp fills cover both directions",
  perpReceipts.some((r) => /long/.test(r.side)) && perpReceipts.some((r) => /short/.test(r.side)));
check("perp fills cover open and close",
  perpReceipts.some((r) => /open/.test(r.side)) && perpReceipts.some((r) => /close/.test(r.side)));
check("the measured perp rate matches the fills",
  near(ACCOUNT_FEES.perp.taker, perpReceipts[0].impliedRate, 1e-12));
check("a spot receipt is recorded", FILL_RECEIPTS.some((r) => r.venue === "spot"));
check("every perp fill carries its exchange order number",
  perpReceipts.every((r) => /^\d{19}$/.test(r.orderId ?? "")),
  perpReceipts.map((r) => r.orderId).join(" "));
check("perp order numbers are distinct",
  new Set(perpReceipts.map((r) => r.orderId)).size === 4);
// The spot fill has no order number because the order screen did not show one. That gap is
// recorded as null and explained, rather than omitted so it looks like nobody checked.
check("the spot fill records its missing order number as null",
  FILL_RECEIPTS.find((r) => r.venue === "spot")!.orderId === null);
check("the spot fill says why it has no order number",
  /did not display one/.test(FILL_RECEIPTS.find((r) => r.venue === "spot")!.note ?? ""));

// ---------------------------------------------------------------- book walking

group("book walking");
{
  const b = makeBook(2, 100);
  const e = execution(b, 2_000, "long")!;
  check("mid recovered", near(e.mid, 100));
  check("spread recovered", near(e.spreadBp, 2, 1e-3), `got ${e.spreadBp}`);
  check("small order pays half spread each way", near(e.roundTripBp!, 2, 1e-3), `got ${e.roundTripBp}`);
  check("round trip is entry plus exit", near(e.roundTripBp!, e.entry.bp! + e.exit.bp!));

  const big = execution(makeBook(2, 2, 100), 10_000, "long")!;
  check("larger order costs more than smaller", big.roundTripBp! > e.roundTripBp!,
    `${big.roundTripBp} vs ${e.roundTripBp}`);

  const tiny = execution(makeBook(2, 0.1, 2), 10_000, "long")!;
  check("partial fill reports null round trip", tiny.roundTripBp === null);
  check("partial fill still reports what filled", tiny.entry.filledUsd > 0 && tiny.entry.filledUsd < 10_000,
    `${tiny.entry.filledUsd}`);
  check("partial fill flags exhausted", tiny.entry.exhausted === true);

  check("empty book has no execution", execution(EMPTY_BOOK, 2_000, "long") === null);
  check("one sided book has no execution", execution({ asks: [[100, 1]], bids: [], ts: null }, 100, "long") === null);
  check("crossed book rejected", execution({ asks: [[99, 10]], bids: [[101, 10]], ts: null }, 100, "long") === null);

  const short = execution(b, 2_000, "short")!;
  check("short on a symmetric book costs the same", near(short.roundTripBp!, e.roundTripBp!, 1e-6));

  check("toBook parses string levels", toBook([["1.5", "2"]], [["1.4", "2"]], "123").asks[0][0] === 1.5);
  check("toBook rejects a bad timestamp", toBook([[1, 1]], [[1, 1]], "nope").ts === null);
}

// ---------------------------------------------------------------- funding

group("funding");
{
  check("quantile midpoint", near(quantile([1, 2, 3, 4], 0.5), 2.5));
  check("quantile of empty is zero", quantile([], 0.5) === 0);

  const flat = settlements(30, 0.0001);
  const daily = trailingDailyFunding(flat, NOW, 7, 8);
  check("trailing estimator annualises by interval", near(daily!, 0.0003, 1e-9), `got ${daily}`);
  check("empty window returns null, not zero", trailingDailyFunding([], NOW, 7, 8) === null);

  const p = projectFunding(flat, 30, "long", { atMs: NOW, intervalHours: 8 });
  check("30d of 3bp/day is about 90bp", near(p.bp.mid, 90, 0.5), `got ${p.bp.mid}`);
  check("flat funding gives a tight range", near(p.bp.high - p.bp.low, 0, 0.5), `got ${p.bp.high - p.bp.low}`);
  check("range is ordered", p.bp.low <= p.bp.mid && p.bp.mid <= p.bp.high);

  const zero = projectFunding(settlements(30, 0), 30, "long", { atMs: NOW });
  check("zero funding projects zero", near(zero.bp.mid, 0));
  check("zero funding is not flagged missing", zero.missing === false);

  const neg = projectFunding(settlements(30, -0.0001), 30, "long", { atMs: NOW });
  check("negative funding is a credit for a long", neg.bp.mid < 0, `got ${neg.bp.mid}`);

  const shortSide = projectFunding(flat, 30, "short", { atMs: NOW });
  check("short receives what long pays", near(shortSide.bp.mid, -p.bp.mid, 1e-6),
    `${shortSide.bp.mid} vs ${p.bp.mid}`);
  check("short range still ordered", shortSide.bp.low <= shortSide.bp.high);

  const missing = projectFunding([], 30, "long", { atMs: NOW });
  check("no history is flagged missing", missing.missing === true);
  check("no history projects zero rather than guessing", near(missing.bp.mid, 0));

  // A spiky month against a quiet week should widen the band, not exclude the centre.
  const spiky: Settlement[] = [
    ...settlements(30, 0).slice(0, 60).map((s, i) => ({ ...s, rate: i % 10 === 0 ? 0.003 : 0 })),
    ...settlements(7, 0),
  ];
  const sp = projectFunding(spiky, 30, "long", { atMs: NOW });
  check("spiky history widens the band", sp.bp.high > sp.bp.mid || sp.bp.low < sp.bp.mid);
  check("band always contains the centre", sp.bp.low <= sp.bp.mid && sp.bp.mid <= sp.bp.high);

  check("crossover closes a gap", near(crossoverDays(2, 8), 4));
  check("zero daily cost never closes a gap", crossoverDays(0, 8) === Infinity);
  check("negative daily cost never closes a gap", crossoverDays(-1, 8) === Infinity);
}

// ---------------------------------------------------------------- eligibility

group("eligibility");
{
  const c = { ...DEFAULT_CONSTRAINTS };
  check("spot cannot short", checkEligibility("rtoken", "short", c, "regular").eligible === false);
  check("perp can short", checkEligibility("perp", "short", c, "regular").eligible === true);
  check("short rejection explains itself in plain words",
    /bet on a price falling/i.test(checkEligibility("rtoken", "short", c, "regular").reason ?? ""),
    checkEligibility("rtoken", "short", c, "regular").reason ?? "");

  const lev = { ...c, leverage: 3 };
  check("leverage rules out spot", checkEligibility("rtoken", "long", lev, "regular").eligible === false);
  check("leverage allowed on perp", checkEligibility("perp", "long", lev, "regular").eligible === true);

  const vote = { ...c, wantsVoting: true };
  check("voting rules out rToken", checkEligibility("rtoken", "long", vote, "regular").eligible === false);
  check("voting rules out perp", checkEligibility("perp", "long", vote, "regular").eligible === false);
  check("voting allows Stock+", checkEligibility("stockplus", "long", vote, "regular").eligible === true);

  const div = { ...c, wantsDividends: true };
  // Bitget's dividend treatment of the perpetual is not established, so it must be flagged as
  // unknown rather than used to rule the route out.
  check("perpetual dividend treatment is unconfirmed, not assumed",
    checkEligibility("perp", "long", div, "regular").eligible === true
      && checkEligibility("perp", "long", div, "regular").unverified.length > 0);
  check("unconfirmed dividend treatment is flagged, not guessed",
    checkEligibility("rtoken", "long", div, "regular").unverified.length > 0);

  check("Stock+ is closed overnight", checkEligibility("stockplus", "long", c, "overnight").eligible === false);
  check("perp trades overnight", checkEligibility("perp", "long", c, "overnight").eligible === true);
  const offHours = { ...c, needsOffHoursExit: true };
  check("off hours exit rules out Stock+",
    checkEligibility("stockplus", "long", offHours, "regular").eligible === false);
}

// ---------------------------------------------------------------- the four gates

group("engine: gates");
{
  const q = priceIntent(intent(), {
    session: "regular",
    books: { rtoken: makeBook(6, 100), perp: makeBook(1, 100) },
    funding: settlements(30, 0),
    now: NOW,
  });
  check("both live routes price", q.routes.filter((r) => r.status === "ok").length === 2);
  check("perp wins on a tighter book", q.recommended === "perp", `got ${q.recommended}`);
  check("ranks are assigned", q.routes.find((r) => r.route === "perp")!.rank === 1);
  const sp = q.routes.find((r) => r.route === "stockplus")!;
  check("Stock+ with no reachable book is modeled, not no_book", sp.status === "modeled", sp.status);
  check("Stock+ shows the fee it does know", sp.feeBp !== null);
  check("Stock+ admits execution is unknown", sp.executionBp === null && sp.totalBp === null);
  check("Stock+ is kept out of the ranking", sp.rank === null);
  check("Stock+ says why it cannot be priced",
    /does not publish live prices/i.test(sp.reason ?? ""), sp.reason ?? "");
  // Anyone reading a number should see where the fee came from without asking.
  const rt = q.routes.find((r) => r.route === "rtoken")!;
  const pp = q.routes.find((r) => r.route === "perp")!;
  check("rToken quote labels its fee as measured", rt.feeProvenance === "measured", `${rt.feeProvenance}`);
  check("perp quote labels its fee as measured", pp.feeProvenance === "measured", `${pp.feeProvenance}`);
  check("rToken quote names its fee source", /rGOOGL/.test(rt.feeSource ?? ""));
  check("perp quote names its fee source", /NVDAUSDT/.test(pp.feeSource ?? ""));
  check("a published-rate quote labels itself published",
    priceIntent(intent(), { session: "regular", books: { rtoken: makeBook(6, 100), perp: makeBook(1, 100) },
      funding: settlements(30, 0), now: NOW, fees: PUBLISHED_FEES })
      .routes.find((r) => r.route === "perp")!.feeProvenance === "published");
  check("total is fee plus execution plus funding", (() => {
    const p = q.routes.find((r) => r.route === "perp")!;
    return near(p.totalBp!.mid, p.feeBp! + p.executionBp! + p.fundingBp!.mid, 1e-3);
  })());
  check("the perp no longer raises an unverified warning",
    !q.warnings.some((w) => /not confirmed/i.test(w) && /perp/.test(w)));
  check("the BGB caveat stays with the fee schedule, not under every answer",
    /BGB/.test(ACCOUNT_FEES.spot.caveat ?? "") && !q.warnings.some((w) => /BGB/.test(w)));
}

group("engine: empty book is a headline state");
{
  const q = priceIntent(intent(), {
    session: "overnight",
    books: { rtoken: EMPTY_BOOK, perp: makeBook(1, 100) },
    funding: settlements(30, 0),
    now: NOW,
  });
  const r = q.routes.find((x) => x.route === "rtoken")!;
  check("empty book reports no_book", r.status === "no_book", r.status);
  check("empty book is not priced", r.totalBp === null);
  // An empty book means Bitget published no depth, not that the market is closed. The
  // reason must say it cannot be priced and must not claim nobody trades it.
  check("empty book says it cannot be priced",
    /cannot price it/i.test(r.reason ?? ""), r.reason ?? "");
  check("empty book does not claim the market is dead",
    !/nobody (is quoting|trades)|could not (buy|sell)|no market/i.test(r.reason ?? ""), r.reason ?? "");
  check("empty book reports zero absorbable", r.absorbableUsd === 0);
  check("the other route still wins", q.recommended === "perp");
  check("Stock+ closed overnight is ineligible",
    q.routes.find((x) => x.route === "stockplus")!.status === "ineligible");
}

group("engine: cannot fill at size");
{
  const q = priceIntent(intent({ notionalUsd: 100_000 }), {
    session: "regular",
    books: { rtoken: makeBook(2, 0.5, 3), perp: makeBook(1, 100) },
    funding: settlements(30, 0),
    now: NOW,
  });
  const r = q.routes.find((x) => x.route === "rtoken")!;
  check("oversized order reports cannot_fill", r.status === "cannot_fill", r.status);
  check("cannot_fill is not priced", r.totalBp === null);
  check("cannot_fill names what the book holds", (r.absorbableUsd ?? 0) > 0);
  check("cannot_fill explains in dollars", /Only about \$/.test(r.reason ?? ""), r.reason ?? "");
}

group("engine: every route ineligible");
{
  const q = priceIntent(intent({ direction: "short", constraints: { ...DEFAULT_CONSTRAINTS, wantsVoting: true } }), {
    session: "regular",
    books: { rtoken: makeBook(2, 100), perp: makeBook(1, 100) },
    funding: settlements(30, 0),
    now: NOW,
  });
  check("nothing is recommended", q.recommended === null);
  check("every route carries a reason", q.routes.every((r) => r.reason !== null));
  check("the dead end is stated", q.warnings.some((w) => /None of the three ways/i.test(w)));
}

group("engine: staleness is visible");
{
  const q = priceIntent(intent(), {
    session: "regular",
    books: { rtoken: makeBook(2, 100), perp: makeBook(1, 100) },
    funding: settlements(30, 0),
    stalenessMs: { rtoken: 600_000 },
    now: NOW,
  });
  const r = q.routes.find((x) => x.route === "rtoken")!;
  check("stale snapshot is marked", r.status === "stale", r.status);
  check("stale route still shows its numbers", r.totalBp !== null);
  check("stale route says how old", /600 seconds ago/.test(r.reason ?? ""), r.reason ?? "");
}

group("engine: a stale route is still a tradeable route");
{
  // This was a real defect on the deployed build: stale routes were dropped from the
  // ranking, so the banner said nothing could be traded while the cards below printed
  // two prices with dollar figures.
  const q = priceIntent(intent(), {
    session: "regular",
    books: { rtoken: makeBook(10, 100), perp: makeBook(2, 100) },
    funding: settlements(30, 0),
    stalenessMs: { rtoken: 600_000, perp: 600_000 },
    now: NOW,
  });
  check("stale routes still rank", q.recommended !== null, `${q.recommended}`);
  check("stale routes get a rank number", q.routes.filter((r) => r.rank !== null).length === 2);
  check("stale does not trigger the nothing-tradeable warning",
    !q.warnings.some((w) => /No route can trade/i.test(w)));
  check("stale is still visible on the route", q.routes.find((r) => r.route === "perp")!.status === "stale");

  // The banner must still fire where it should.
  const reallyDead = priceIntent(intent({ direction: "short", constraints: { ...DEFAULT_CONSTRAINTS, wantsVoting: true } }), {
    session: "regular", books: { rtoken: makeBook(2, 100), perp: makeBook(2, 100) }, funding: settlements(30, 0), now: NOW,
  });
  check("genuinely ineligible still reports nothing tradeable", reallyDead.recommended === null);
  check("the copy a user reads avoids Bitget-internal jargon and desk units", (() => {
    const text = [
      ...q.routes.map((r) => r.reason ?? ""),
      ...q.warnings,
      ...q.routes.map((r) => r.label),
    ].join(" ");
    /*
     * Deliberately permits perpetual, funding, spread, long and short. Those are the words
     * this audience already trades in, and replacing them explained things nobody needed
     * explained. What stays blocked is Bitget-internal naming and desk units.
     */
    return !/rToken|basis point|bp|order book|notional/i.test(text);
  })());
}

group("engine: session advice is worth acting on");
{
  const o: SessionOutlook[] = [
    { session: "premarket", executionBp: 6.8, emptyShare: 0, samples: 66 },
    { session: "regular", executionBp: 8.7, emptyShare: 0, samples: 66 },
    { session: "afterhours", executionBp: 7.3, emptyShare: 0, samples: 66 },
    { session: "overnight", executionBp: 6.4, emptyShare: 0, samples: 66 },
  ];
  check("a saving under 1bp is not advice", betterSession(o, "premarket") === null);
  check("a saving over 1bp is", betterSession(o, "regular")?.session === "overnight");
  check("it names the cheapest session, not merely a cheaper one",
    betterSession(o, "regular")?.executionBp === 6.4);
  check("the threshold is adjustable", betterSession(o, "premarket", 0.1)?.session === "overnight");

  // Somewhere with no book is not somewhere to send anyone.
  const withDead: SessionOutlook[] = [
    { session: "regular", executionBp: 20, emptyShare: 0, samples: 66 },
    { session: "overnight", executionBp: 1, emptyShare: 1, samples: 66 },
    { session: "afterhours", executionBp: 15, emptyShare: 0, samples: 66 },
  ];
  check("a session whose book is always empty is skipped",
    betterSession(withDead, "regular")?.session === "afterhours");
}

group("engine: gate 4, does the horizon decide");
{
  const tight = priceIntent(intent(), {
    session: "regular",
    books: { rtoken: makeBook(2, 100), perp: makeBook(1.5, 100) },
    funding: settlements(30, 0),
    now: NOW,
  });
  check("close execution means the horizon decides", tight.horizonDecides === true);

  const wide = priceIntent(intent(), {
    session: "regular",
    books: { rtoken: makeBook(60, 100), perp: makeBook(1, 100) },
    funding: settlements(30, 0),
    now: NOW,
  });
  check("a 30bp execution gap means execution decides", wide.horizonDecides === false);

  const noBook = priceIntent(intent(), {
    session: "overnight",
    books: { rtoken: EMPTY_BOOK, perp: makeBook(1, 100) },
    funding: settlements(30, 0),
    now: NOW,
  });
  check("no book means the horizon cannot decide", noBook.horizonDecides === false);
}

group("engine: gate 3, a better session");
{
  const outlook: SessionOutlook[] = [
    { session: "regular", executionBp: 16.7, emptyShare: 0, samples: 66 },
    { session: "premarket", executionBp: 24.6, emptyShare: 0, samples: 62 },
    { session: "overnight", executionBp: 23.7, emptyShare: 0, samples: 60 },
  ];
  const b = betterSession(outlook, "premarket")!;
  check("a cheaper session is named", b.session === "regular", JSON.stringify(b));
  check("the saving is quantified", near(b.savingBp, 7.9, 1e-6), `got ${b?.savingBp}`);
  check("the best session has nothing better", betterSession(outlook, "regular") === null);
  check("no outlook means no suggestion", betterSession(undefined, "regular") === null);
  check("a session with no data is skipped",
    betterSession([{ session: "regular", executionBp: null, emptyShare: null, samples: 0 }], "regular") === null);
}

group("engine: counterfactual sessions use measured execution");
{
  const books = { rtoken: makeBook(2, 100), perp: makeBook(2, 100) };
  const here = priceIntent(intent(), { session: "regular", books, funding: settlements(30, 0), now: NOW });
  const elsewhere = priceIntent(intent(), {
    session: "overnight", books, funding: settlements(30, 0), now: NOW,
    executionBpOverride: { rtoken: 40 },
  });
  const a = here.routes.find((r) => r.route === "rtoken")!;
  const b = elsewhere.routes.find((r) => r.route === "rtoken")!;
  check("override replaces the live execution cost", near(b.executionBp!, 40), `got ${b.executionBp}`);
  check("without an override the live book is used", near(a.executionBp!, 2, 1e-3), `got ${a.executionBp}`);
  check("override changes the recommendation", here.recommended !== elsewhere.recommended,
    `${here.recommended} vs ${elsewhere.recommended}`);

  // A session where the sampler only ever saw an empty book is untradeable at that hour,
  // even though the book is fine right now.
  const dead = priceIntent(intent(), {
    session: "overnight", books, funding: settlements(30, 0), now: NOW,
    executionBpOverride: { rtoken: null },
  });
  const d = dead.routes.find((r) => r.route === "rtoken")!;
  check("a session with no book ever is no_book", d.status === "no_book", d.status);
  check("that no_book says it was measured, not guessed",
    /Every time we checked at this hour/.test(d.reason ?? ""), d.reason ?? "");
  check("the live route still prices", dead.recommended === "perp");

  // An override must still answer for a route whose book is empty right now.
  const emptyNow = priceIntent(intent(), {
    session: "regular", books: { rtoken: EMPTY_BOOK, perp: makeBook(2, 100) },
    funding: settlements(30, 0), now: NOW, executionBpOverride: { rtoken: 5 },
  });
  const e = emptyNow.routes.find((r) => r.route === "rtoken")!;
  check("override prices a route that is empty right now", e.status === "ok", e.status);
  check("override with no live book reports no absorbable size", e.absorbableUsd === null);
}

group("engine: funding actually moves the answer");
{
  const equal = { rtoken: makeBook(2, 100), perp: makeBook(2, 100) };

  /*
   * On the account's real rates the rToken round trip is 8bp against the perp's 12bp, so on
   * two identical books the rToken wins at every horizon even with funding at zero. That is
   * the opposite of the flip test, which assumed 20bp against 12bp. It is asserted here so
   * the inversion is a tested property rather than a surprise in the demo.
   */
  const flat = priceIntent(intent({ horizonDays: 1 }), {
    session: "regular", books: equal, funding: settlements(30, 0), now: NOW,
  });
  check("equal books and no funding now favour the rToken", flat.recommended === "rtoken", `got ${flat.recommended}`);

  // The perp has to buy its way back with a tighter book, and 4bp of round trip is the price.
  const tighter = priceIntent(intent({ horizonDays: 1 }), {
    session: "regular", books: { rtoken: makeBook(10, 100), perp: makeBook(2, 100) }, funding: settlements(30, 0), now: NOW,
  });
  check("a tighter perp book overcomes the fee gap", tighter.recommended === "perp", `got ${tighter.recommended}`);

  const dear = priceIntent(intent({ horizonDays: 90 }), {
    session: "regular", books: { rtoken: makeBook(10, 100), perp: makeBook(2, 100) }, funding: settlements(30, 0.001), now: NOW,
  });
  check("costly funding takes the long horizon back", dear.recommended === "rtoken", `got ${dear.recommended}`);

  const short1 = priceIntent(intent({ horizonDays: 1 }), {
    session: "regular", books: equal, funding: settlements(30, 0.001), now: NOW,
  });
  const short90 = priceIntent(intent({ horizonDays: 90 }), {
    session: "regular", books: equal, funding: settlements(30, 0.001), now: NOW,
  });
  check("funding scales with horizon", (() => {
    const a = short1.routes.find((r) => r.route === "perp")!.fundingBp!.mid;
    const b = short90.routes.find((r) => r.route === "perp")!.fundingBp!.mid;
    return near(b, a * 90, 0.5);
  })());
}

// ---------------------------------------------------------------- monitor

group("monitor: should you move a position you already hold");
{
  const position = (over: Partial<Position> = {}): Position => ({
    id: "p1",
    ticker: "NVDA",
    route: "perp",
    notionalUsd: 10_000,
    direction: "long",
    openedAt: new Date(NOW - 10 * DAY).toISOString(),
    horizonDays: 30,
    ...over,
  });

  check("days remaining counts down from opening",
    near(daysRemaining(position(), NOW), 20, 0.01), `${daysRemaining(position(), NOW)}`);
  check("an overrun position has no days left",
    daysRemaining(position({ horizonDays: 5 }), NOW) === 0);

  const books = { rtoken: makeBook(4, 100), perp: makeBook(2, 100) };

  // Expensive funding on the perp is the case where moving is genuinely right.
  const costly = analysePosition(position(), {
    books, funding: settlements(30, 0.002), now: NOW,
  });
  check("costly funding says move", costly.verdict === "switch", costly.verdict);
  check("it names what moving costs", (costly.switchCostBp ?? 0) > 0);
  check("it quantifies the saving", (costly.netSavingBp?.mid ?? 0) > 0);
  check("it says when the move pays for itself", costly.breakevenDays > 0 && costly.breakevenDays < 30);
  check("the message is in dollars, not basis points",
    /\$\d/.test(costly.message) && !/bp/.test(costly.message), costly.message);

  // Zero funding is the common case, and moving then is pure cost.
  const quiet = analysePosition(position(), { books, funding: settlements(30, 0), now: NOW });
  check("zero funding says stay", quiet.verdict === "stay", quiet.verdict);
  check("staying is explained in what it would have cost", /would cost/.test(quiet.message));

  /*
   * The case that matters most for trust: cheaper elsewhere, but not by enough to cover the
   * round trip. A tool that tells you to pay $12 to save $4 is worse than useless.
   *
   * Rather than hand-picking a funding rate that lands in that window, sweep until one does.
   * The invariant is what matters, not the constant, and a hand-picked constant stops testing
   * anything the moment a fee changes.
   */
  const tight = { rtoken: makeBook(0.5, 100), perp: makeBook(0.5, 100) };
  let marginal: ReturnType<typeof analysePosition> | null = null;
  for (let rate = 0.000002; rate < 0.00006; rate += 0.000002) {
    const a = analysePosition(position(), { books: tight, funding: settlements(30, rate), now: NOW });
    if (a.verdict === "not_worth_it") { marginal = a; break; }
  }
  check("there is a band where moving is cheaper but not worth it", marginal !== null);
  if (marginal) {
    check("and it says so plainly", /Not worth the trade/.test(marginal.message), marginal.message);
    check("the saving is real but smaller than the move",
      (marginal.netSavingBp?.mid ?? 0) > 0 && (marginal.netSavingBp?.mid ?? 0) < (marginal.switchCostBp ?? 0));
  }

  // The rule the whole feature rests on: never advise a move that does not clear its own cost
  // by the margin of safety. Swept across a wide range of funding levels.
  check("a move is never advised unless it clears its cost by the margin", (() => {
    for (let rate = 0; rate < 0.004; rate += 0.00005) {
      const a = analysePosition(position(), { books: tight, funding: settlements(30, rate), now: NOW });
      if (a.verdict !== "switch") continue;
      if ((a.netSavingBp?.mid ?? 0) <= (a.switchCostBp ?? 0) * 0.25) return false;
    }
    return true;
  })());

  // Being unable to get out matters more than whether leaving would be wise.
  const stuck = analysePosition(position({ route: "rtoken" }), {
    books: { rtoken: EMPTY_BOOK, perp: makeBook(2, 100) }, funding: settlements(30, 0), now: NOW,
  });
  check("no market means stuck, not stay", stuck.verdict === "stuck", stuck.verdict);
  check("stuck is flagged on the analysis", stuck.cannotExit === true);
  check("no published depth says an exit cannot be priced",
    /cannot price an exit/.test(stuck.message), stuck.message);
  check("and does not claim you cannot sell", !/could not sell|cannot get out/.test(stuck.message));
  check("stuck offers no switch arithmetic", stuck.netSavingBp === null);

  // Nowhere to move to is a different answer from "moving is a bad idea".
  const nowhere = analysePosition(position(), {
    books: { perp: makeBook(2, 100), rtoken: EMPTY_BOOK }, funding: settlements(30, 0.002), now: NOW,
  });
  check("no alternative means stay", nowhere.verdict === "stay", nowhere.verdict);
  check("and says there is nowhere to go", /no other tradeable way/.test(nowhere.message));

  // An alternative too thin to absorb the position is not an alternative.
  const thin = analysePosition(position(), {
    books: { perp: makeBook(2, 100), rtoken: makeBook(2, 0.2, 3) },
    funding: settlements(30, 0.002), now: NOW,
  });
  check("an unfillable alternative means stay", thin.verdict === "stay", thin.verdict);
  check("and says it cannot take the size", /cannot take \$/.test(thin.message), thin.message);

  // Holding the spot side, there is no funding to escape, so moving is never right.
  const onSpot = analysePosition(position({ route: "rtoken" }), {
    books, funding: settlements(30, 0.002), now: NOW,
  });
  check("holding the unfunded side, moving is never advised", onSpot.verdict !== "switch", onSpot.verdict);
  check("the funding it would take on is counted", (onSpot.switchFundingBp?.mid ?? 0) > 0);

  // A short can only live on the perpetual, so it is never told to move to spot.
  const short = analysePosition(position({ direction: "short" }), {
    books, funding: settlements(30, 0.002), now: NOW,
  });
  check("a short is never told to move to the tokenized stock", short.verdict !== "switch", short.verdict);
  check("a short says why it cannot move", /Only the perpetual can hold a short/.test(short.message), short.message);

  // The range has to survive into the recommendation.
  check("the saving is a range, not a point",
    costly.netSavingBp !== null && costly.netSavingBp.low <= costly.netSavingBp.mid
      && costly.netSavingBp.mid <= costly.netSavingBp.high);
  check("a bigger margin of safety refuses more moves", (() => {
    const strict = analysePosition(position(), {
      books, funding: settlements(30, 0.0002), now: NOW, marginOfSafety: 50,
    });
    return strict.verdict !== "switch";
  })());
}

// ---------------------------------------------------------------- order splitting

group("splitting a large order across the two wrappers");
{
  const flat = settlements(30, 0);
  const quoteFor = (books: { rtoken: Book; perp: Book }, over: Partial<Intent> = {}, funding = flat) =>
    priceIntent(intent(over), { session: "regular", books, funding, now: NOW });

  // Deep books and a small order: one wrapper is simply cheaper, so no split.
  const deep = { rtoken: makeBook(2, 1_000), perp: makeBook(2, 1_000) };
  const small = planSplit(quoteFor(deep), deep);
  check("a small order on deep books is not split", small.applicable && !small.worthIt, JSON.stringify({ w: small.worthIt, s: small.perpShare }));

  // Two thin books: walking deep into either one is expensive, so sharing the order is cheaper.
  const thin = { rtoken: makeBook(2, 1, 60), perp: makeBook(2, 1, 60) };
  const big = planSplit(quoteFor(thin, { notionalUsd: 3_000 }), thin);
  check("a large order on two thin books is split", big.worthIt, JSON.stringify({ share: big.perpShare, save: big.savingUsd }));
  check("the split lands between the extremes", big.perpShare > 0.2 && big.perpShare < 0.8, `${big.perpShare}`);
  check("the two parts add up to the order", near(big.perpUsd + big.tokenUsd, 3_000, 0.02));
  check("the saving is stated in dollars", big.savingUsd > 0);

  // A deep perpetual and a thin token: most of the order should go where the depth is.
  const lopsided = { rtoken: makeBook(2, 1, 60), perp: makeBook(2, 1_000) };
  const lean = planSplit(quoteFor(lopsided, { notionalUsd: 3_000 }), lopsided);
  check("most of the order goes to the deeper book", lean.perpShare >= 0.8, `${lean.perpShare}`);

  // The invariant the feature rests on: a split never costs more than the best single route.
  check("the best split never costs more than the best single route", (() => {
    for (const n of [500, 2_000, 3_000, 5_000]) {
      for (const bk of [deep, thin, lopsided]) {
        const plan = planSplit(quoteFor(bk, { notionalUsd: n }), bk);
        if (plan.applicable && plan.bestSingle && plan.totalUsd > plan.bestSingle.totalUsd + 0.01) return false;
      }
    }
    return true;
  })());

  // The chart has to agree with the single-route prices at its two ends.
  const ends = planSplit(quoteFor(thin, { notionalUsd: 2_000 }), thin);
  const allPerp = ends.curve[ends.curve.length - 1];
  const allToken = ends.curve[0];
  check("the chart runs from all tokenized to all perpetual", allToken.perpShare === 0 && allPerp.perpShare === 1);

  // Expensive funding makes the perpetual side costlier to hold, so less of the order goes there.
  const cheapFund = planSplit(quoteFor(thin, { notionalUsd: 3_000 }), thin);
  const dearFund = planSplit(quoteFor(thin, { notionalUsd: 3_000 }, settlements(30, 0.001)), thin);
  check("costly funding moves the split toward the tokenized stock",
    dearFund.perpShare < cheapFund.perpShare, `${dearFund.perpShare} vs ${cheapFund.perpShare}`);

  // No split where one side cannot be priced or cannot express the view.
  const noDepth = { rtoken: EMPTY_BOOK, perp: makeBook(2, 1_000) };
  const blocked = planSplit(quoteFor(noDepth), noDepth);
  check("no split when one side has no published depth", !blocked.applicable && blocked.reason !== null);
  const short = planSplit(quoteFor(deep, { direction: "short", constraints: { ...DEFAULT_CONSTRAINTS, needsShort: true } }), deep);
  check("a short is never split, since only the perpetual can hold it", !short.applicable);

  // When neither wrapper can take the whole order alone, splitting is the only way to fill it.
  const tiny = { rtoken: makeBook(2, 1, 12), perp: makeBook(2, 1, 12) };
  const forced = planSplit(quoteFor(tiny, { notionalUsd: 2_000 }), tiny);
  check("a split can fill what neither book can alone", forced.applicable && forced.bestSingle === null && forced.worthIt,
    JSON.stringify({ a: forced.applicable, s: forced.bestSingle, w: forced.worthIt }));
}

// ---------------------------------------------------------------- the underlying share

group("the underlying share: premium, dividends, earnings");
{
  const now = Date.parse("2026-09-23T15:00:00Z");

  // KO's real ex-dividend history, as Bitget's market data service returns it.
  const ko = ["2025-06-12", "2025-09-14", "2025-11-30", "2026-03-12", "2026-06-14", "2026-09-14"];
  const nextDiv = projectNext(ko, now)!;
  check("a quarterly dividend projects about three months after the last", nextDiv !== null
    && Date.parse(nextDiv.date) > Date.parse("2026-11-20") && Date.parse(nextDiv.date) < Date.parse("2027-01-10"), nextDiv?.date);
  check("the projection says how many past dates it used", nextDiv.basedOn >= 3);
  check("the projection is always in the future", Date.parse(nextDiv.date) > now);

  // NVDA's report dates, duplicates included, the way the service returns them.
  const nvda = ["2025-11-18", "2026-02-24", "2026-02-24", "2026-05-19", "2026-08-25", "2026-08-25"];
  const nextEarn = projectNext(nvda, now)!;
  check("duplicate dates do not distort the rhythm", nextEarn !== null && nextEarn.intervalDays > 80 && nextEarn.intervalDays < 110,
    JSON.stringify(nextEarn));

  // KO's calendar lists two dates a day apart for one report. They are one event.
  const koEarn = projectNext(["2025-10-28", "2026-01-27", "2026-04-28", "2026-07-27", "2026-07-28"], now);
  check("dates days apart count as one event", koEarn !== null && koEarn.intervalDays > 60, JSON.stringify(koEarn));

  // KO's real feed contains an ex-date in 2152. It must not break the projection or its amount.
  const withJunk = shareOutlook(
    { symbol: "KO", price: { last: 88, prevClose: 88 }, source: "test", earnings: [],
      dividends: [{ exDate: "2152-07-11", amount: 0.36 }, ...ko.map((d) => ({ exDate: d, amount: 0.53 }))] },
    null, now, 90,
  );
  check("an impossible future date is ignored", withJunk.nextDividend !== null && !withJunk.nextDividend.date.startsWith("2152"),
    JSON.stringify(withJunk.nextDividend));
  check("and its amount is not used", withJunk.nextDividend?.amount === 0.53, `${withJunk.nextDividend?.amount}`);

  // A dividend already on the calendar a few weeks out is announced, not projected.
  const announced = shareOutlook(
    { symbol: "X", price: { last: 50, prevClose: 50 }, source: "test", earnings: [],
      dividends: [{ exDate: "2026-10-20", amount: 0.4 }, ...ko.map((d) => ({ exDate: d, amount: 0.38 }))] },
    null, now, 60,
  );
  check("an upcoming date in the data is reported as announced", announced.nextDividend?.announced === true
    && announced.nextDividend.date === "2026-10-20" && announced.nextDividend.amount === 0.4, JSON.stringify(announced.nextDividend));

  // A guess dressed as a date is worse than no date.
  check("too little history is not projected", projectNext(["2026-06-14", "2026-09-14"], now) === null);
  check("an irregular series is not projected", projectNext(["2026-01-01", "2026-01-30", "2026-06-20", "2026-09-10"], now) === null);

  check("a date inside the holding period is flagged", withinHorizon({ date: "2026-10-15", basedOn: 4, intervalDays: 91 }, now, 30));
  check("a date past the holding period is not", !withinHorizon({ date: "2026-12-15", basedOn: 4, intervalDays: 91 }, now, 30));

  check("a token above the share price shows a positive premium", near(premiumBp(100.3, 100)!, 30, 0.2));
  check("a token below shows a discount", premiumBp(99.8, 100)! < 0);
  check("a missing price gives no premium rather than zero", premiumBp(null, 100) === null && premiumBp(100, 0) === null);
  check("dividend yield is the payment over the price", near(dividendYieldPct(0.53, 73)!, 0.726, 0.001));

  const out = shareOutlook(
    { symbol: "KO", price: { last: 73, prevClose: 72.8 }, dividends: ko.map((d) => ({ exDate: d, amount: 0.53 })), earnings: [], source: "test" },
    73.1, now, 90,
  );
  check("the outlook carries the premium", out.premiumBp !== null && out.premiumBp > 0);
  check("a 90 day hold catches the next quarterly dividend", out.nextDividend?.inHorizon === true, JSON.stringify(out.nextDividend));
  check("no earnings history means no earnings claim", out.nextEarnings === null);
}

// ---------------------------------------------------------------- the tokenized stock is priced from its quote

group("the tokenized stock is priced from Bitget's quote");
{
  const row = { bid1Price: "224.22", ask1Price: "224.23", bid1Size: "254", ask1Size: "100", ts: String(NOW) };
  const qb = quoteBook(row);
  check("a ticker row becomes a one level book marked as a quote",
    qb.source === "quote" && qb.asks.length === 1 && qb.bids.length === 1 && qb.asks[0][1] === 100);

  const quoted = priceIntent(intent(), {
    session: "regular", books: { rtoken: qb, perp: makeBook(2, 1_000) }, funding: settlements(30, 0), now: NOW,
  });
  const rt = quoted.routes.find((r) => r.route === "rtoken")!;
  const spreadBp = ((224.23 - 224.22) / 224.225) * 10_000;
  check("a quoted route is priced and says where its price came from", rt.status === "ok" && rt.source === "quote", rt.status);
  check("inside the quoted size the round trip is exactly the quoted spread",
    near(rt.executionBp!, spreadBp, 1e-3), `${rt.executionBp} vs ${spreadBp}`);
  check("the perpetual is still priced from its book",
    quoted.routes.find((r) => r.route === "perp")!.source === "book");

  const big = priceIntent(intent({ notionalUsd: 50_000 }), {
    session: "regular", books: { rtoken: qb, perp: makeBook(2, 1_000) }, funding: settlements(30, 0), now: NOW,
  });
  const bigRt = big.routes.find((r) => r.route === "rtoken")!;
  check("beyond the quoted size the tokenized stock is not priced", bigRt.status === "cannot_fill", bigRt.status);
  check("and the page states the quoted size, not that the price would move",
    /quote for the tokenized stock covers about \$/.test(bigRt.reason ?? "") && !/move the price/.test(bigRt.reason ?? ""), bigRt.reason ?? "");

  const none = priceIntent(intent(), {
    session: "regular", books: { rtoken: quoteBook({ bid1Price: "0", ask1Price: "0", bid1Size: "0", ask1Size: "0" }), perp: makeBook(2, 1_000) },
    funding: settlements(30, 0), now: NOW,
  });
  const noneRt = none.routes.find((r) => r.route === "rtoken")!;
  check("with no two sided quote the tokenized stock cannot be priced", noneRt.status === "no_book");
  check("and the reason names the missing price, not the order book",
    /not quoting both a bid and an ask/.test(noneRt.reason ?? ""), noneRt.reason ?? "");

  check("four test orders are recorded", QUOTE_TESTS.length === 4);
  check("every test order filled within 2bp of the quote", QUOTE_TESTS.every((t) => fillGaps(t).quoteBp <= 2),
    JSON.stringify(QUOTE_TESTS.map(fillGaps)));
  check("where there was an order book, every fill was nearer the quote than the book",
    QUOTE_TESTS.filter((t) => t.book).every((t) => fillGaps(t).quoteBp < fillGaps(t).bookBp!));
  const spotTests = FILL_RECEIPTS.filter((f) => f.venue === "spot" && f.orderId);
  check("the test orders carry order numbers and a 4bp fee", spotTests.length === 4 &&
    spotTests.every((f) => near(f.impliedRate * 10_000, 4.0, 0.02)),
    spotTests.map((f) => (f.impliedRate * 10_000).toFixed(3)).join(" "));
}

// ---------------------------------------------------------------- keeping the model to the engine's numbers

group("the explanation may only use the engine's figures");
{
  const books = { rtoken: makeBook(2, 1_000), perp: makeBook(6, 1_000) };
  const q = priceIntent(intent(), { session: "regular", books, funding: settlements(30, 0.0001), now: NOW });
  const sheet = factSheet(q, { timeZone: "America/New_York" });
  const rt = q.routes.find((r) => r.route === "rtoken")!;
  const rtDollars = ((rt.totalBp!.mid / 10_000) * 2_000).toFixed(2);

  check("the sheet carries each priced route's total in dollars", sheet.text.includes(`$${rtDollars}`), sheet.text);
  check("the sheet states the verdict", /Verdict: use the tokenized stock/.test(sheet.text), sheet.text);
  // A wide funding band is not "too close to call" when even the perpetual's best case costs more.
  const swingy: Settlement[] = settlements(30, 0).map((s, k) => ({ ...s, rate: k % 5 === 0 ? 0.001 : 0 }));
  const clear = priceIntent(intent(), { session: "regular", books, funding: swingy, now: NOW });
  const cr = clear.routes.find((r) => r.route === "rtoken")!.totalBp!;
  const cp = clear.routes.find((r) => r.route === "perp")!.totalBp!;
  check("the case is set up: a wide band, but no overlap", cp.high - cp.low > cp.mid - cr.mid && cp.low > cr.high,
    JSON.stringify({ cr, cp }));
  check("ranges that do not overlap give a clear verdict, not too close to call",
    /Verdict: use the tokenized stock/.test(factSheet(clear).text), factSheet(clear).text);
  check("the sheet gives session hours in the reader's time", /US market hours 09:30 to 16:00/.test(sheet.text));

  check("a figure copied from the sheet passes",
    ungroundedNumbers(`The tokenized stock costs $${rtDollars} in total.`, sheet).length === 0);
  check("a figure rounded to fewer places passes",
    ungroundedNumbers(`About $${Math.round(Number(rtDollars))} in total.`, sheet).length === 0);
  check("an invented figure is caught",
    ungroundedNumbers("You would save $123.45 by waiting.", sheet).join() === "123.45");
  check("a figure worked out from two on the sheet is caught",
    ungroundedNumbers(`Together that is $${(Number(rtDollars) * 2 + 0.01).toFixed(2)}.`, sheet).length === 1);
  check("a number the reader typed may be repeated back",
    ungroundedNumbers("At 3am it is overnight.", sheet, "what about at 3am?").length === 0);
  check("without the question the same number is caught",
    ungroundedNumbers("At 3am it is overnight.", sheet).join() === "3");
  check("thousands separators are read as one number",
    ungroundedNumbers("On $2,000 of NVDA.", sheet).length === 0);
  check("a sentence ending in a number keeps its figure", ungroundedNumbers("It is 30.", sheet).length === 0);

  check("dashes used as punctuation become commas",
    plainText(`Cheaper ${String.fromCharCode(0x2014)} by a lot.`) === "Cheaper, by a lot.");
  check("a dash between two figures becomes 'to'",
    plainText(`$1.20${String.fromCharCode(0x2013)}$3.40`) === "$1.20 to $3.40");
  check("markdown emphasis is dropped", plainText("**Use the perpetual.**") === "Use the perpetual.");

  check("session hours follow the reader's zone",
    sessionHoursIn("Africa/Lagos", new Date("2026-09-16T12:00:00Z")).startsWith("pre-market 09:00 to 14:30"));
  check("session hours follow daylight saving",
    sessionHoursIn("Europe/London", new Date("2026-11-03T12:00:00Z")).startsWith("pre-market 09:00 to 14:30") &&
    sessionHoursIn("Europe/London", new Date("2026-09-16T12:00:00Z")).startsWith("pre-market 09:00 to 14:30") &&
    sessionHoursIn("Europe/London", new Date("2026-10-28T12:00:00Z")).startsWith("pre-market 08:00 to 13:30"));
}

// ---------------------------------------------------------------- prediction log

group("prediction log");
{
  const base = { session: "regular" as const, funding: settlements(30, 0), now: NOW };

  const contested = priceIntent(intent(), {
    ...base, books: { rtoken: makeBook(10, 100), perp: makeBook(2, 100) },
  });
  const rec = toRecord(contested, "selftest");
  check("record carries the chosen route", rec.route === contested.recommended);
  check("record carries the predicted cost", rec.predictedBp !== null);
  check("record carries the range, not just a point",
    rec.predictedLowBp !== null && rec.predictedHighBp !== null);
  check("record carries ticker, session, notional and horizon",
    rec.ticker === "NVDA" && rec.session === "regular" && rec.notionalUsd === 2000 && rec.horizonDays === 30);
  check("record timestamps the call", !Number.isNaN(Date.parse(rec.at)));
  check("record id is stable for the same call", rec.id === toRecord(contested, "selftest").id);
  check("record keeps every route's status for later diagnosis", rec.routes.length === 3);
  check("two tradeable routes means execution decided", rec.decidedBy === "execution", rec.decidedBy);
  check("rationale is plain language", /by \d/.test(rec.rationale), rec.rationale);

  // The gate that decided is the part worth auditing later.
  const empty = priceIntent(intent(), {
    ...base, books: { rtoken: EMPTY_BOOK, perp: makeBook(2, 100) },
  });
  check("an empty book means availability decided", toRecord(empty, "t").decidedBy === "availability",
    toRecord(empty, "t").decidedBy);
  check("availability rationale names the missing book",
    /no order book/i.test(toRecord(empty, "t").rationale), toRecord(empty, "t").rationale);

  const tooBig = priceIntent(intent({ notionalUsd: 100_000 }), {
    ...base, books: { rtoken: makeBook(2, 0.5, 3), perp: makeBook(2, 5000) },
  });
  check("an unfillable book means size decided", toRecord(tooBig, "t").decidedBy === "size",
    toRecord(tooBig, "t").decidedBy);

  const tight = priceIntent(intent(), {
    ...base, books: { rtoken: makeBook(2, 100), perp: makeBook(1.5, 100) },
  });
  check("execution inside the fee gap means the horizon decided",
    toRecord(tight, "t").decidedBy === "horizon", toRecord(tight, "t").decidedBy);

  const dead = priceIntent(intent({ direction: "short", constraints: { ...DEFAULT_CONSTRAINTS, wantsVoting: true } }), {
    ...base, books: { rtoken: makeBook(2, 100), perp: makeBook(2, 100) },
  });
  const deadRec = toRecord(dead, "t");
  check("no tradeable route is still logged as a call", deadRec.decidedBy === "no_route", deadRec.decidedBy);
  check("no tradeable route logs a null route with no invented cost",
    deadRec.route === null && deadRec.predictedBp === null);

  check("the record survives a JSON round trip",
    JSON.parse(JSON.stringify(rec)).id === rec.id);
  check("the file name is dated from the call, not from now",
    predictionFile("d", new Date("2026-09-16T23:00:00Z")).endsWith("predictions-2026-09-16.ndjson"));
}

// ---------------------------------------------------------------- done

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
