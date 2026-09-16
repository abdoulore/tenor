#!/usr/bin/env node
/**
 * Offline test suite for the cost engine. No network, in the flip test's selftest style.
 *
 *   node engine/selftest.ts
 *
 * Covers the degenerate cases the plan names: empty book, partial fill, zero funding,
 * negative funding, missing data, and every route ineligible.
 */

import { execution, toBook } from "./book.ts";
import { ACCOUNT_FEES, FLIP_TEST_FEES, feeGapBp, roundTripFeeBp } from "./fees.ts";
import { checkEligibility } from "./eligibility.ts";
import { crossoverDays, projectFunding, quantile, trailingDailyFunding, type Settlement } from "./funding.ts";
import { betterSession, priceIntent } from "./engine.ts";
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
check("account spot round trip is 8bp", near(roundTripFeeBp("rtoken", ACCOUNT_FEES), 8));
check("account perp round trip is 12bp", near(roundTripFeeBp("perp", ACCOUNT_FEES), 12));
check("flip test spot round trip was 20bp", near(roundTripFeeBp("rtoken", FLIP_TEST_FEES), 20));
check("flip test fee gap was 8bp toward the perp", near(feeGapBp(FLIP_TEST_FEES), 8));
check("account fee gap is 4bp toward the rToken", near(feeGapBp(ACCOUNT_FEES), -4),
  `got ${feeGapBp(ACCOUNT_FEES)}`);

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
  check("short rejection explains itself",
    /short/i.test(checkEligibility("rtoken", "short", c, "regular").reason ?? ""));

  const lev = { ...c, leverage: 3 };
  check("leverage rules out spot", checkEligibility("rtoken", "long", lev, "regular").eligible === false);
  check("leverage allowed on perp", checkEligibility("perp", "long", lev, "regular").eligible === true);

  const vote = { ...c, wantsVoting: true };
  check("voting rules out rToken", checkEligibility("rtoken", "long", vote, "regular").eligible === false);
  check("voting rules out perp", checkEligibility("perp", "long", vote, "regular").eligible === false);
  check("voting allows Stock+", checkEligibility("stockplus", "long", vote, "regular").eligible === true);

  const div = { ...c, wantsDividends: true };
  check("dividends rule out perp", checkEligibility("perp", "long", div, "regular").eligible === false);
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
  check("Stock+ says why it is not ranked", /not ranked/i.test(sp.reason ?? ""));
  check("total is fee plus execution plus funding", (() => {
    const p = q.routes.find((r) => r.route === "perp")!;
    return near(p.totalBp!.mid, p.feeBp! + p.executionBp! + p.fundingBp!.mid, 1e-3);
  })());
  check("unverified perp fee raises a warning", q.warnings.some((w) => /not confirmed/i.test(w)));
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
  check("empty book says untradeable, not expensive", /no order book/i.test(r.reason ?? ""));
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
  check("cannot_fill explains in dollars", /book holds about \$/.test(r.reason ?? ""));
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
  check("the dead end is stated", q.warnings.some((w) => /No route can trade/i.test(w)));
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
  check("stale route says how old", /600s old/.test(r.reason ?? ""));
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
  check("that no_book names the session", /overnight/.test(d.reason ?? ""), d.reason ?? "");
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

// ---------------------------------------------------------------- done

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
