/**
 * Tenor: the surface.
 *
 * Four gates in order, shown in that order: can you trade it, at your size, at this hour,
 * for how long. The break-even tab only appears when the horizon genuinely decides, which
 * the prediction log says is about 5% of calls.
 *
 * Every number here comes from the deterministic engine. Nothing on this page is generated.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { priceIntent, betterSession } from "../../engine/engine.ts";
import { fetchBook, fetchFunding, listTickers, resolvePair, type Pair } from "../../engine/bitget.ts";
import { sessionLabel } from "../../engine/book.ts";
import { DEFAULT_FEES, roundTripFeeBp } from "../../engine/fees.ts";
import { ROUTE_BLURBS } from "../../engine/eligibility.ts";
import { crossoverDays } from "../../engine/funding.ts";
import {
  DEFAULT_CONSTRAINTS,
  type Book, type Constraints, type Intent, type Quote, type RouteResult,
  type Session, type SessionOutlook,
} from "../../engine/types.ts";
import type { Settlement } from "../../engine/funding.ts";
import { getParser } from "./parse.ts";
import outlookData from "./data/outlook.json";
import { IntentControls, type FieldOrigin } from "./IntentControls.tsx";
import { SessionChart } from "./SessionChart.tsx";
import { BreakEven } from "./BreakEven.tsx";

const SESSIONS: Session[] = ["premarket", "regular", "afterhours", "overnight"];
const SIZES = [2_000, 10_000];

/** Session names as a person would say them, not as an exchange would. */
const SESSION_WORDS: Record<string, string> = {
  regular: "US markets are open",
  premarket: "Before the US open",
  afterhours: "After the US close",
  overnight: "Overnight in the US",
  weekend: "Weekend, US markets shut",
};

type OutlookFile = typeof outlookData;

/** Turn the bundled medians into the shape the engine wants. */
function outlookFor(ticker: string, size: number): Record<"rtoken" | "perp" | "stockplus", SessionOutlook[]> {
  const entry = (outlookData as OutlookFile).tickers[ticker as keyof OutlookFile["tickers"]] as
    | Record<string, Record<string, { samples: number; emptyShare: number; bp: Record<string, number | null> }>>
    | undefined;
  const build = (route: "rtoken" | "perp"): SessionOutlook[] => {
    const byS = entry?.[route];
    if (!byS) return [];
    return SESSIONS.filter((s) => byS[s]).map((s) => ({
      session: s,
      executionBp: byS[s].bp[String(size)] ?? null,
      emptyShare: byS[s].emptyShare,
      samples: byS[s].samples,
    }));
  };
  return { rtoken: build("rtoken"), perp: build("perp"), stockplus: [] };
}

/*
 * Money leads, precision follows.
 *
 * A basis point is a hundredth of a percent, and nobody outside a trading desk thinks in
 * them. Every figure on this page is shown as dollars on the amount the user actually asked
 * about, with the percentage kept beside it in small type for anyone who wants it.
 */
const usd = (bp: number, notional: number) => {
  const d = (bp / 10_000) * notional;
  const abs = Math.abs(d);
  const digits = abs >= 100 ? 0 : 2;
  return `${d < 0 ? "-" : ""}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  })}`;
};

/** The same number as a percentage of the position, for the people who prefer it. */
const pctOf = (bp: number | null | undefined) =>
  bp === null || bp === undefined ? "n/a" : `${(bp / 100).toFixed(3)}%`;

const fmtBp = (x: number | null | undefined, dp = 2) =>
  x === null || x === undefined ? "n/a" : `${x.toFixed(dp)}bp`;

function Range({ r, notional }: { r: { low: number; mid: number; high: number }; notional: number }) {
  const tight = Math.abs(r.high - r.low) < 0.005;
  return (
    <span className="range">
      <strong>{fmtBp(r.mid)}</strong>
      <span className="sub"> {usd(r.mid, notional)}</span>
      {!tight && <span className="band"> {fmtBp(r.low)} to {fmtBp(r.high)}</span>}
    </span>
  );
}

const STATUS_COPY: Record<string, { title: string; tone: string }> = {
  no_book: { title: "Nothing on offer", tone: "dead" },
  cannot_fill: { title: "Not enough on offer", tone: "warn" },
  ineligible: { title: "Will not do what you asked", tone: "dead" },
  modeled: { title: "Cannot be priced", tone: "muted" },
  stale: { title: "Prices a moment old", tone: "warn" },
};

function RouteCard({
  r, notional, best, horizonDays, decisionBp, symbol,
}: {
  r: RouteResult; notional: number; best: boolean; horizonDays: number;
  decisionBp: number | null; symbol?: string;
}) {
  const copy = STATUS_COPY[r.status];
  const priced = r.totalBp !== null;
  const certain = (r.feeBp ?? 0) + (r.executionBp ?? 0);
  const bandWidth = r.fundingBp ? r.fundingBp.high - r.fundingBp.low : 0;
  const wideBand = decisionBp !== null && bandWidth > Math.abs(decisionBp);

  return (
    <div className={`route ${best ? "best" : ""} ${copy?.tone ?? "ok"}`}>
      <div className="route-head">
        <span className="route-name">{r.label}</span>
        {symbol && <span className="symbol">{symbol}</span>}
        {best && <span className="badge">cheapest</span>}
        {copy && <span className={`badge ${copy.tone}`}>{copy.title}</span>}
      </div>
      <div className="blurb">{ROUTE_BLURBS[r.route]}</div>

      {priced ? (
        <>
          {/*
            * The headline is the part we actually measured: the fee plus what the spread
            * costs you getting in and getting back out. Funding is a forecast and sits
            * separately, because folding a forecast into one confident number is the one
            * thing here a reader could fairly call dishonest.
            */}
          <div className="route-total">
            <strong>{usd(certain, notional)}</strong>
            <span className="band"> to buy and sell again</span>
            <span className="sub"> {pctOf(certain)} of your ${notional.toLocaleString()}</span>
          </div>
          <div className="breakdown">
            <span>Bitget's fee {usd(r.feeBp ?? 0, notional)}</span>
            <span className={`prov ${r.feeProvenance}`}>
              {r.feeProvenance === "measured" ? "from a real trade" : "published rate"}
            </span>
            <span>price gap {usd(r.executionBp ?? 0, notional)}</span>
          </div>

          {r.route === "perp" && r.fundingBp && (
            <div className={`funding ${wideBand ? "wide" : ""}`}>
              <span className="fl">
                {r.fundingBp.mid >= 0 ? "Holding fee" : "Holding payment to you"} over {horizonDays} days
              </span>
              <span className="fv">
                {usd(Math.abs(r.fundingBp.mid), notional)}
                {bandWidth > 0.005 && (
                  <em>
                    could be anywhere from {usd(r.fundingBp.low, notional)} to {usd(r.fundingBp.high, notional)}
                  </em>
                )}
              </span>
            </div>
          )}

          {r.route === "perp" && r.totalBp && (
            <div className="route-sum">
              Expected all in: <strong>{usd(r.totalBp.mid, notional)}</strong>
              {bandWidth > 0.005 && (
                <span> somewhere between {usd(r.totalBp.low, notional)} and {usd(r.totalBp.high, notional)}</span>
              )}
            </div>
          )}

          {wideBand && (
            <div className="note loud">
              Most of this cost is the holding fee, and nobody can tell you what that will be
              over {horizonDays} days. The uncertainty is larger than the gap between the two
              options, so treat this ranking as a coin toss rather than an answer.
            </div>
          )}

          {r.absorbableUsd !== null && r.absorbableUsd < notional * 3 && (
            <div className="note">
              Only about ${r.absorbableUsd.toLocaleString()} is on offer, so a much larger order
              would start moving the price against you.
            </div>
          )}
        </>
      ) : (
        <div className="reason">{r.reason}</div>
      )}
      {priced && r.reason && <div className="note">{r.reason}</div>}
    </div>
  );
}

export default function App() {
  const [text, setText] = useState("$2,000 of NVDA for a month, no leverage");
  const [tickers, setTickers] = useState<string[]>([]);
  const [intent, setIntent] = useState<Intent | null>(null);
  /** Where each field's current value came from, so nothing on screen is unexplained. */
  const [origins, setOrigins] = useState<Record<string, FieldOrigin>>({});
  const [parseInfo, setParseInfo] = useState<{ parser: string; note?: string } | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [pair, setPair] = useState<Pair | null>(null);
  const [books, setBooks] = useState<{ spot: Book; perp: Book } | null>(null);
  /*
   * Staleness is a real condition, not the default state. Books are fetched live on every
   * request, so a fresh fetch is never stale however long the page has been open. Only a
   * failed fetch that falls back to the last good books is, and then it says how old they are.
   */
  const [fellBackAt, setFellBackAt] = useState<number | null>(null);
  const lastGood = useRef<{ spot: Book; perp: Book; at: number } | null>(null);
  const [funding, setFunding] = useState<Settlement[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"routes" | "sessions" | "breakeven">("routes");
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  /** Nothing is priced until this is true. */
  const [asked, setAsked] = useState(false);
  const [now, setNow] = useState(Date.now());

  const parser = useMemo(() => getParser(), []);
  const session = useMemo(() => sessionLabel(new Date(now)) as Session, [now]);
  const reqId = useRef(0);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { listTickers().then(setTickers).catch(() => setTickers([])); }, []);

  /** Fetch the two markets for a ticker. Only needed when the company changes. */
  const loadMarket = useCallback(async (ticker: string, id: number) => {
    const p = await resolvePair(ticker);
    if (id !== reqId.current) return false;
    if (!p) {
      throw new Error(
        `Bitget does not offer both a tokenized stock and a futures contract for ${ticker}, ` +
        `so there is nothing to compare. Try a larger US name such as NVDA, AAPL or TSLA.`,
      );
    }
    setPair(p);

    const [spotRes, perpRes, fundRes] = await Promise.allSettled([
      fetchBook("SPOT", p.spotSymbol),
      fetchBook("USDT-FUTURES", p.perpSymbol),
      fetchFunding(p.perpSymbol),
    ]);
    if (id !== reqId.current) return false;

    // An empty book is a live answer and must not be confused with a failed call. Only a
    // rejection falls back, and only then is anything stale.
    const prev = lastGood.current;
    const failed = spotRes.status === "rejected" || perpRes.status === "rejected";
    const spot = spotRes.status === "fulfilled" ? spotRes.value : prev?.spot;
    const perp = perpRes.status === "fulfilled" ? perpRes.value : prev?.perp;
    if (!spot || !perp) throw new Error("Bitget did not answer and there is no earlier price to fall back on.");

    if (!failed) {
      lastGood.current = { spot, perp, at: Date.now() };
      setFellBackAt(null);
    } else {
      setFellBackAt(prev?.at ?? null);
    }

    setBooks({ spot, perp });
    setFunding(fundRes.status === "fulfilled" ? fundRes.value : []);
    setFetchedAt(Date.now());
    return true;
  }, []);

  /** Read the sentence, then load whatever it named. */
  const run = useCallback(async () => {
    const id = ++reqId.current;
    setStatus("loading");
    setError(null);
    try {
      const parsed = await parser.parse(text, tickers.length ? tickers : ["NVDA", "MSFT", "SOXL", "AAOI", "HOOD"]);
      if (id !== reqId.current) return;
      if (!parsed.intent.ticker) {
        throw new Error("We could not spot a company in that. Name a US stock, for example NVDA or Tesla.");
      }

      const next: Record<string, FieldOrigin> = {};
      for (const f of ["ticker", "size", "direction", "horizon", "leverage"]) {
        next[f] = parsed.found.includes(f) ? "read" : "assumed";
      }
      setOrigins(next);
      setParseInfo({ parser: parsed.parser, note: parsed.note });
      setIntent(parsed.intent);

      const ok = await loadMarket(parsed.intent.ticker, id);
      if (!ok || id !== reqId.current) return;
      setAsked(true);
      setStatus("idle");
    } catch (e) {
      if (id !== reqId.current) return;
      setError((e as Error).message);
      setStatus("error");
      setQuote(null);
    }
  }, [parser, text, tickers, loadMarket]);

  /**
   * Edit a field directly.
   *
   * This never re-reads the sentence. The controls are the intent, so what you set is what
   * gets priced, and the sentence above is only how it started. Changing the company is the
   * one edit that needs fresh prices from Bitget.
   */
  const edit = useCallback((patch: Partial<Intent> & { constraints?: Partial<Constraints> }) => {
    setIntent((prev) => {
      if (!prev) return prev;
      const next: Intent = {
        ...prev,
        ...patch,
        constraints: { ...prev.constraints, ...(patch.constraints ?? {}) },
      };
      return next;
    });

    setOrigins((prev) => {
      const out = { ...prev };
      if (patch.ticker !== undefined) out.ticker = "edited";
      if (patch.notionalUsd !== undefined) out.size = "edited";
      if (patch.direction !== undefined) out.direction = "edited";
      if (patch.horizonDays !== undefined) out.horizon = "edited";
      if (patch.constraints?.leverage !== undefined) out.leverage = "edited";
      return out;
    });

    // Before anyone has asked, changing a field just changes the field.
    if (asked && patch.ticker !== undefined && patch.ticker.length >= 1) {
      const id = ++reqId.current;
      setStatus("loading");
      setError(null);
      loadMarket(patch.ticker, id)
        .then((ok) => { if (ok) setStatus("idle"); })
        .catch((e) => {
          if (id !== reqId.current) return;
          setError((e as Error).message);
          setStatus("error");
          setQuote(null);
        });
    }
  }, [asked, loadMarket]);

  // Re-price whenever anything it depends on moves. Pricing is pure and cheap, so this is
  // recomputed rather than cached, which keeps the staleness indicator honest.
  useEffect(() => {
    if (!asked || !intent || !books || !pair) return;
    const outlook = outlookFor(intent.ticker, nearestSize(intent.notionalUsd));
    const age = fellBackAt !== null ? now - fellBackAt : null;
    const q = priceIntent(intent, {
      session,
      books: { rtoken: books.spot, perp: books.perp },
      funding,
      fundingIntervalHours: pair.fundingIntervalHours,
      outlook,
      stalenessMs: age !== null ? { rtoken: age, perp: age } : undefined,
      now,
    });
    setQuote(q);
  }, [asked, intent, books, pair, funding, session, fellBackAt, now]);

  /*
   * Seed the controls, price nothing.
   *
   * The fields are filled in so the page is immediately usable and shows what it can answer,
   * but no verdict appears until someone asks for one. Pricing on load would put a
   * recommendation for a stock nobody mentioned at the top of the page, which reads as advice
   * rather than as a default.
   */
  useEffect(() => {
    if (intent) return;
    setIntent({
      ticker: "NVDA",
      notionalUsd: 2_000,
      direction: "long",
      horizonDays: 30,
      constraints: { ...DEFAULT_CONSTRAINTS },
    });
    setOrigins({ ticker: "assumed", size: "assumed", direction: "assumed", horizon: "assumed", leverage: "assumed" });
  }, [intent]);

  /** Ask. This is the only thing that turns fields into an answer. */
  const priceIt = useCallback(async () => {
    if (!intent?.ticker) return;
    const id = ++reqId.current;
    setStatus("loading");
    setError(null);
    try {
      const ok = await loadMarket(intent.ticker, id);
      if (!ok || id !== reqId.current) return;
      setAsked(true);
      setStatus("idle");
    } catch (e) {
      if (id !== reqId.current) return;
      setError((e as Error).message);
      setStatus("error");
      setQuote(null);
    }
  }, [intent, loadMarket]);

  const outlook = intent ? outlookFor(intent.ticker, nearestSize(intent.notionalUsd)) : null;
  const coverage = (outlookData as OutlookFile).coverage;

  return (
    <div className="page">
      <header>
        <div className="brand">
          <h1>Tenor</h1>
          <p>
            Bitget sells three ways to own the same US stock. They do not cost the same, and
            which is cheapest changes with your size, the hour, and how long you hold.
          </p>
        </div>
        <div className="live">
          <span className={`dot ${session}`} /> {SESSION_WORDS[session]}
        </div>
      </header>

      {intent && (
        <IntentControls
          intent={intent}
          origins={origins}
          tickers={tickers}
          onChange={edit}
          busy={status === "loading"}
        />
      )}


      {/*
        * The sentence is a shortcut now, not the way you drive this. The controls above are
        * the intent, so this sits underneath as a faster way to fill them in when someone
        * would rather type than click. Kept because typing "20k of palantir for three months
        * at 3x" really is quicker than setting five fields.
        */}
      <details className="shortcut">
        <summary>Or describe it in a sentence</summary>
        <div className="intent">
          <textarea
            aria-label="Describe what you want to do"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run(); }}
            rows={2}
            placeholder="20k of palantir for three months at 3x"
          />
          <button onClick={() => void run()} disabled={status === "loading"}>
            {status === "loading" ? "Reading" : "Fill the fields"}
          </button>
        </div>
        {parseInfo && (
          <p className="shortcut-note">
            {parseInfo.parser === "model" ? "Read by AI." : "Read by simple rules."} It only fills
            the fields above. Every number you see is worked out from live Bitget prices, not written
            by the AI.
          </p>
        )}
      </details>

      {intent && (
        <div className="ask">
          <button className="primary" onClick={() => void priceIt()} disabled={status === "loading" || !intent.ticker}>
            {status === "loading" ? "Checking Bitget" : asked ? "Check again" : `Price ${intent.ticker || "it"}`}
          </button>
          {!asked && status !== "loading" && (
            <span className="ask-note">
              Nothing is priced until you ask. We will read the live prices for both ways of
              holding {intent.ticker || "it"} and tell you which costs less.
            </span>
          )}
        </div>
      )}

      {parseInfo?.note && <div className="assumed standalone">{parseInfo.note}</div>}

      {error && <section className="error"><strong>Cannot price this.</strong> {error}</section>}

      {quote && intent && (
        <>
          <nav className="tabs">
            <button className={tab === "routes" ? "on" : ""} onClick={() => setTab("routes")}>
              Your options
            </button>
            <button className={tab === "sessions" ? "on" : ""} onClick={() => setTab("sessions")}>
              Best time to trade
            </button>
            {quote.horizonDecides && (
              <button className={tab === "breakeven" ? "on" : ""} onClick={() => setTab("breakeven")}>
                How long you hold
              </button>
            )}
          </nav>

          {tab === "routes" && (
            <section className="routes">
              <Verdict quote={quote} notional={intent.notionalUsd} />
              {quote.routes.map((r) => (
                <RouteCard
                  key={r.route}
                  r={r}
                  notional={intent.notionalUsd}
                  best={r.rank === 1}
                  horizonDays={intent.horizonDays}
                  decisionBp={decisionGap(quote)}
                  symbol={r.route === "rtoken" ? pair?.spotSymbol : r.route === "perp" ? pair?.perpSymbol : undefined}
                />
              ))}
              {(["rtoken", "perp"] as const).map((route) => {
                const b = outlook ? betterSession(outlook[route], session) : null;
                return b ? (
                  <div className="hint" key={route}>
                    The {route === "rtoken" ? "tokenized stock" : "futures contract"} is usually{" "}
                    <strong>{usd(b.savingBp, intent.notionalUsd)} cheaper</strong> to trade{" "}
                    {SESSION_WORDS[b.session].toLowerCase()} than right now.
                  </div>
                ) : null;
              })}
            </section>
          )}

          {tab === "sessions" && outlook && (
            <SessionChart outlook={outlook} current={session} size={nearestSize(intent.notionalUsd)} />
          )}

          {tab === "breakeven" && (
            <BreakEven quote={quote} funding={funding} intervalHours={pair?.fundingIntervalHours ?? 8} />
          )}

          <section className="followups">
            <span className="label">What if</span>
            <button onClick={() => edit({ horizonDays: 7 })}>I only hold a week</button>
            <button onClick={() => edit({ horizonDays: 90 })}>I hold three months</button>
            <button onClick={() => edit({ notionalUsd: intent.notionalUsd * 5 })}>
              I put in five times as much
            </button>
            <button
              onClick={() => {
                const direction = intent.direction === "long" ? "short" : "long";
                edit({ direction, constraints: { needsShort: direction === "short" } });
              }}
            >
              I bet the other way
            </button>
          </section>

          <section className="warnings">
            {quote.warnings.map((w) => <div key={w} className="warn-line">{w}</div>)}
            {fetchedAt && (
              <div className="warn-line">
                {fellBackAt !== null
                  ? `Bitget did not answer just now, so these prices are ${Math.round((now - fellBackAt) / 1000)} seconds old.`
                  : `Prices read from Bitget ${Math.round((now - fetchedAt) / 1000)} seconds ago.`}
                {" "}The hour-by-hour figures come from {coverage.records.toLocaleString()} price
                checks taken every five minutes between {String(coverage.from).slice(0, 10)} and{" "}
                {String(coverage.to).slice(0, 10)}. That is a few days of evidence, not years of it.
              </div>
            )}
          </section>
        </>
      )}

      <footer>
        Every price here is read live from Bitget and worked out with ordinary arithmetic.
        The AI only reads your sentence. It never produces a number you see.
        Fees used: {pctOf(roundTripFeeBp("rtoken", DEFAULT_FEES))} to buy and sell the tokenized stock,
        {" "}{pctOf(roundTripFeeBp("perp", DEFAULT_FEES))} for the futures contract.
      </footer>
    </div>
  );
}

function Chip({ k, v, found }: { k: string; v: string; found: boolean }) {
  return <span className={`chip ${found ? "found" : "assumed"}`}><em>{k}</em> {v}</span>;
}

function Verdict({ quote, notional }: { quote: Quote; notional: number }) {
  const best = quote.routes.find((r) => r.rank === 1);
  const second = quote.routes.find((r) => r.rank === 2);
  const dead = quote.routes.find((r) => r.route !== "stockplus" && r.status === "no_book");

  if (!best) {
    return (
      <div className="verdict none">
        <strong>There is no way to do this right now.</strong>
        <span>All three options are ruled out. Each one says why underneath.</span>
      </div>
    );
  }

  if (!second) {
    return (
      <div className="verdict only">
        <strong>Only one option works: the {best.label.toLowerCase()}.</strong>
        <span>
          {dead
            ? `Nobody is quoting a price for the ${dead.label.toLowerCase()} at all, so there is nothing to compare it against.`
            : "Nothing else can do what you asked."}
        </span>
      </div>
    );
  }

  const diff = second.totalBp!.mid - best.totalBp!.mid;
  /*
   * If the holding-fee forecast is wider than the gap between the two options, the ranking
   * is a coin toss wearing a suit. Say that in the headline, not the footnotes.
   */
  const widestBand = Math.max(
    ...quote.routes.map((r) => (r.fundingBp ? r.fundingBp.high - r.fundingBp.low : 0)),
  );
  if (widestBand > Math.abs(diff)) {
    return (
      <div className="verdict unsettled">
        <strong>Too close to call.</strong>
        <span>
          The {best.label.toLowerCase()} is ahead by {usd(diff, notional)}, but the holding fee on
          the futures contract could swing the result by {usd(widestBand, notional)} over{" "}
          {quote.intent.horizonDays} days. Buying and selling is the only part anyone can price
          honestly today.
        </span>
      </div>
    );
  }

  return (
    <div className="verdict">
      <strong>Use the {best.label.toLowerCase()}. It saves you {usd(diff, notional)}.</strong>
      <span>
        On ${notional.toLocaleString()} of {quote.intent.ticker}, held {quote.intent.horizonDays} days.
        {" "}
        {quote.horizonDecides
          ? "The two are close enough that how long you hold is what decides it."
          : "What decides it is the cost of getting in and back out, not the holding period."}
      </span>
    </div>
  );
}

/** How much separates the best two ranked routes, which is what the answer turns on. */
function decisionGap(quote: Quote): number | null {
  const a = quote.routes.find((r) => r.rank === 1);
  const b = quote.routes.find((r) => r.rank === 2);
  if (!a?.totalBp || !b?.totalBp) return null;
  return b.totalBp.mid - a.totalBp.mid;
}

/** The sampler only walked $2,000 and $10,000, so medians snap to a measured size. */
function nearestSize(n: number): number {
  return SIZES.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
}
