/**
 * Tenor: the surface.
 *
 * Four gates in order, shown in that order: can you trade it, at your size, at this hour,
 * for how long. The break-even tab only appears when the horizon genuinely decides, which
 * the prediction log says is about 5% of calls.
 *
 * Every number here comes from the deterministic engine. The explanation under the result is
 * written by a model, from the engine's figures, and is withheld if it contains any other figure.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { priceIntent, betterSession } from "../../engine/engine.ts";
import { fetchBook, fetchFunding, fetchQuote, listTickers, resolvePair, type Pair } from "../../engine/bitget.ts";
import { sessionLabel } from "../../engine/book.ts";
import { DEFAULT_FEES, roundTripFeeBp } from "../../engine/fees.ts";
import { ROUTE_BLURBS, theRoute, TheRoute } from "../../engine/eligibility.ts";
import { crossoverDays } from "../../engine/funding.ts";
import {
  DEFAULT_CONSTRAINTS,
  type Book, type Constraints, type Intent, type Quote, type RouteResult,
  type Session, type SessionOutlook,
} from "../../engine/types.ts";
import type { Settlement } from "../../engine/funding.ts";
import { getParser } from "./parse.ts";
import outlookData from "./data/outlook.json";
import {
  IntentControls, EMPTY_DRAFT, isComplete, type Draft, type DraftPatch, type TickerGroups,
} from "./IntentControls.tsx";
import { Monitor } from "./Monitor.tsx";
import { Receipts } from "./Receipts.tsx";
import { SplitCard } from "./SplitCard.tsx";
import { ShareFacts, useShareFacts } from "./ShareFacts.tsx";
import { Conversation } from "./Conversation.tsx";
import { factSheet } from "../../engine/grounding.ts";
import { shareOutlook } from "../../engine/equity.ts";
import { planSplit, type SplitPlan } from "../../engine/split.ts";
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

/** The same sessions as they read in the middle of a sentence. */
const SESSION_PHRASE: Record<string, string> = {
  regular: "during US market hours",
  premarket: "before the US open",
  afterhours: "after the US close",
  overnight: "overnight",
  weekend: "at the weekend",
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

/** A dollar amount already in dollars, formatted like usd(). */
const usdAmount = (d: number) => usd(10_000, d);

/** The same number as a percentage of the position, for the people who prefer it. */
const pctOf = (bp: number | null | undefined) =>
  bp === null || bp === undefined ? "n/a" : `${(bp / 100).toFixed(3)}%`;

/**
 * Split everything Bitget lists into names we have watched every five minutes, which have hour
 * by hour history, and names we have not, which are priced live but have no history.
 *
 * Every listed name can be priced live, because the tokenized stock is priced from Bitget's
 * quote and every one of them has a quote. The order book, which half of them lack, is not what
 * their orders fill at.
 */
function groupTickers(live: string[]): TickerGroups {
  const watched = Object.keys((outlookData as OutlookFile).tickers);
  const tradeable = watched.filter((t) => live.length === 0 || live.includes(t)).sort();
  const untracked = live.filter((t) => !watched.includes(t)).sort();
  return { tradeable, untracked };
}

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
  no_book: { title: "No quote right now", tone: "warn" },
  cannot_fill: { title: "Above quoted size", tone: "warn" },
  ineligible: { title: "Will not do what you asked", tone: "dead" },
  modeled: { title: "Fee only", tone: "muted" },
  stale: { title: "Prices a moment old", tone: "warn" },
};

function RouteCard({
  r, notional, best, horizonDays, decisionBp, overlap, symbol,
}: {
  r: RouteResult; notional: number; best: boolean; horizonDays: number;
  decisionBp: number | null; overlap: boolean; symbol?: string;
}) {
  const copy = STATUS_COPY[r.status];
  const priced = r.totalBp !== null;
  const certain = (r.feeBp ?? 0) + (r.executionBp ?? 0);
  const bandWidth = r.fundingBp ? r.fundingBp.high - r.fundingBp.low : 0;
  const wideBand = decisionBp !== null && overlap && bandWidth > Math.abs(decisionBp);

  return (
    <div className={`route ${best ? "best" : ""} ${copy?.tone ?? "ok"}`}>
      <div className="route-head">
        <span className="route-name">{r.label}</span>
        {symbol && <span className="symbol">{symbol}</span>}
        {best && <span className="badge">cheapest</span>}
        {copy && <span className={`badge ${copy.tone}`}>{copy.title}</span>}
      </div>
      <div className="blurb">{ROUTE_BLURBS[r.route]}</div>
      {r.source === "quote" && (
        <div className="source-note">
          Priced from Bitget's live quote, the price tokenized stock orders fill at, verified
          with live test orders.
        </div>
      )}

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
            <span className="band"> round trip</span>
            <span className="sub"> {pctOf(certain)} of your ${notional.toLocaleString()}</span>
          </div>
          <div className="breakdown">
            <span>fee {usd(r.feeBp ?? 0, notional)}</span>
            <span className={`prov ${r.feeProvenance}`}>
              {r.feeProvenance === "measured" ? "from a real trade" : "published rate"}
            </span>
            <span>spread and slippage {usd(r.executionBp ?? 0, notional)}</span>
          </div>

          {r.route === "perp" && r.fundingBp && (
            <div className={`funding ${wideBand ? "wide" : ""}`}>
              <span className="fl">
                {r.fundingBp.mid >= 0 ? "Funding" : "Funding paid to you"} over {horizonDays} days
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
              Most of this cost is funding over {horizonDays} days, which is a forecast. Its range
              is wider than the gap between the two options, so the ranking could change.
            </div>
          )}

          {r.absorbableUsd !== null && r.absorbableUsd < notional * 3 && (
            <div className="note">
              {r.source === "quote"
                ? `Bitget's quote covers about $${r.absorbableUsd.toLocaleString()} at this price.`
                : `Only about $${r.absorbableUsd.toLocaleString()} is on offer, so a much larger order would start moving the price against you.`}
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
  /*
   * A draft, not an intent. Every field starts unset and shows a placeholder, so the page
   * never puts a choice in front of someone as though they had made it.
   */
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const intent: Intent | null = useMemo(
    () => (isComplete(draft)
      ? {
          ticker: draft.ticker,
          notionalUsd: draft.notionalUsd!,
          direction: draft.direction!,
          horizonDays: draft.horizonDays!,
          constraints: draft.constraints,
        }
      : null),
    [draft],
  );
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
  const [tab, setTab] = useState<"routes" | "sessions" | "breakeven" | "receipts" | "monitor">("routes");
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
        `Bitget does not offer both a tokenized stock and a perpetual for ${ticker}, ` +
        `so there is nothing to compare. Try a larger US name such as NVDA, AAPL or TSLA.`,
      );
    }
    setPair(p);

    const [spotRes, perpRes, fundRes] = await Promise.allSettled([
      // The tokenized stock is priced from Bitget's quote: that is what its orders fill at.
      fetchQuote(p.spotSymbol),
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

      setParseInfo({ parser: parsed.parser, note: parsed.note });
      setDraft({
        ticker: parsed.intent.ticker,
        notionalUsd: parsed.intent.notionalUsd,
        direction: parsed.intent.direction,
        horizonDays: parsed.intent.horizonDays,
        constraints: parsed.intent.constraints,
      });

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
  const edit = useCallback((patch: DraftPatch) => {
    setDraft((prev) => ({
      ...prev,
      ...patch,
      constraints: { ...prev.constraints, ...(patch.constraints ?? {}) },
    }));

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
    const outlook = outlookFor(intent.ticker, nearestSize(intent.ticker, intent.notionalUsd));
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

  /** Ask. This is the only thing that turns fields into an answer. */
  const priceIt = useCallback(async () => {
    if (!intent) return;
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

  const tickerGroups = useMemo(() => groupTickers(tickers), [tickers]);
  /*
   * The split reuses the quote's own fees and funding and the same live books, so it can never
   * disagree with the prices on the cards above it.
   */
  const split = useMemo(
    () => (quote && books ? planSplit(quote, { rtoken: books.spot, perp: books.perp }) : null),
    [quote, books],
  );
  const outlook = intent ? outlookFor(intent.ticker, nearestSize(intent.ticker, intent.notionalUsd)) : null;
  const coverage = (outlookData as OutlookFile).coverage;

  const share = useShareFacts(asked && intent ? intent.ticker : null);
  // From the quote itself, so the comparison with the share holds even when the route is ruled out.
  const tokenMid = books && books.spot.asks.length && books.spot.bids.length
    ? (books.spot.asks[0][0] + books.spot.bids[0][0]) / 2
    : null;
  const shareOut = useMemo(
    () => (share.facts && intent ? shareOutlook(share.facts, tokenMid, Date.now(), intent.horizonDays) : null),
    [share.facts, tokenMid, intent],
  );
  /*
   * What the explanation may say, written by the engine. Built from the same quote, split and
   * share data as the cards, so the words and the cards cannot disagree.
   */
  const sheet = useMemo(
    () => (quote && intent
      ? factSheet(quote, {
          split,
          share: shareOut,
          sharePrice: share.facts?.price?.last ?? null,
          sessionSize: nearestSize(intent.ticker, intent.notionalUsd),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
      : null),
    [quote, intent, split, shareOut, share.facts],
  );
  // A new result to explain: a different question, or a fresh read of the prices.
  const sig = intent ? `${JSON.stringify(intent)}|${fetchedAt}` : "";

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
          <button
            type="button"
            className={`recordlink ${tab === "receipts" ? "on" : ""}`}
            onClick={() => setTab(tab === "receipts" ? "routes" : "receipts")}
          >
            {tab === "receipts" ? "Back" : "Track record"}
          </button>
          <span className="sep" />
          <button
            type="button"
            className={`recordlink ${tab === "monitor" ? "on" : ""}`}
            onClick={() => setTab(tab === "monitor" ? "routes" : "monitor")}
          >
            {tab === "monitor" ? "Back" : "What I hold"}
          </button>
          <span className="sep" />
          <span className={`dot ${session}`} /> {SESSION_WORDS[session]}
        </div>
      </header>

      <IntentControls
        draft={draft}
        groups={tickerGroups}
        onChange={edit}
        busy={status === "loading"}
      />


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

      <div className="ask">
        <button className="primary" onClick={() => void priceIt()} disabled={status === "loading" || !intent}>
          {status === "loading" ? "Checking Bitget" : asked ? "Check again" : "Price it"}
        </button>
        {!asked && status !== "loading" && (
          <span className="ask-note">
            {intent
              ? `We will read the live prices for both ways of holding ${intent.ticker} and tell you which costs less.`
              : "Fill in the four boxes above and we will compare the ways of holding it."}
          </span>
        )}
      </div>

      {parseInfo?.note && <div className="assumed standalone">{parseInfo.note}</div>}

      {error && <section className="error"><strong>Cannot price this.</strong> {error}</section>}

      {quote ? (
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
          <button className={`right ${tab === "monitor" ? "on" : ""}`} onClick={() => setTab("monitor")}>
            What I hold
          </button>
          <button className={tab === "receipts" ? "on" : ""} onClick={() => setTab("receipts")}>
            Track record
          </button>
        </nav>
      ) : (
        tab !== "receipts" && tab !== "monitor" && (
          <button type="button" className="recordcta" onClick={() => setTab("receipts")}>
            Or see how Tenor's calls have held up
            <span className="arrow">-&gt;</span>
          </button>
        )
      )}

      {tab === "receipts" && <Receipts notional={intent?.notionalUsd ?? 2_000} />}
      {tab === "monitor" && <Monitor groups={tickerGroups} />}

      {quote && intent && tab !== "receipts" && tab !== "monitor" && (
        <>

          {tab === "routes" && (
            <section className="routes">
              <Verdict quote={quote} notional={intent.notionalUsd} split={split} />
              {quote.routes.map((r) => (
                <RouteCard
                  key={r.route}
                  r={r}
                  notional={intent.notionalUsd}
                  best={r.rank === 1}
                  horizonDays={intent.horizonDays}
                  decisionBp={decisionGap(quote)}
                  overlap={unsettled(quote)}
                  symbol={r.route === "rtoken" ? pair?.spotSymbol : r.route === "perp" ? pair?.perpSymbol : undefined}
                />
              ))}
              {split && <SplitCard plan={split} />}
              <ShareFacts
                ticker={intent.ticker}
                share={share}
                tokenMid={tokenMid}
                horizonDays={intent.horizonDays}
                notional={intent.notionalUsd}
                session={session}
              />
              {(["rtoken", "perp"] as const).map((route) => {
                const b = outlook ? betterSession(outlook[route], session) : null;
                return b ? (
                  <div className="hint" key={route}>
                    The {route === "rtoken" ? "tokenized stock" : "perpetual"} is usually{" "}
                    <strong>{usd(b.savingBp, intent.notionalUsd)} cheaper</strong> to trade{" "}
                    {SESSION_PHRASE[b.session]} than right now.
                  </div>
                ) : null;
              })}
            </section>
          )}

          {tab === "sessions" && outlook && (
            <SessionChart
              outlook={outlook}
              current={session}
              size={nearestSize(intent.ticker, intent.notionalUsd)}
              requested={intent.notionalUsd}
              ticker={intent.ticker}
            />
          )}

          {tab === "breakeven" && (
            <BreakEven quote={quote} funding={funding} intervalHours={pair?.fundingIntervalHours ?? 8} />
          )}

          {sheet && (
            <Conversation
              sheet={sheet}
              current={intent}
              sig={sig}
              about={`$${intent.notionalUsd.toLocaleString()} of ${intent.ticker}, ${intent.direction}, held ${intent.horizonDays} days`}
              ready={status !== "loading" && share.state !== "loading"}
              tickers={tickers}
              onReprice={edit}
            >
              <div className="followups">
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
              </div>
            </Conversation>
          )}

          <section className="warnings">
            {quote.warnings
              // A split that fills the order disproves "none of the three will work".
              .filter((w) => !(split?.worthIt && split.bestSingle === null && /None of the three ways/.test(w)))
              .map((w) => <div key={w} className="warn-line">{w}</div>)}
            {fetchedAt && (
              <div className="warn-line">
                {fellBackAt !== null
                  ? `Bitget did not answer just now, so these prices are ${Math.round((now - fellBackAt) / 1000)} seconds old.`
                  : `Prices read from Bitget ${Math.round((now - fetchedAt) / 1000)} seconds ago.`}
                {" "}The hour-by-hour figures come from {coverage.records.toLocaleString()} price
                checks taken every five minutes between {String(coverage.from).slice(0, 10)} and{" "}
                {String(coverage.to).slice(0, 10)}.
              </div>
            )}
          </section>
        </>
      )}

      <footer>
        Every price here is read live from Bitget and worked out by a deterministic cost engine.
        The AI reads your sentence and explains the result, and every figure it writes is checked
        against the engine before it is shown.
        Fees used: {pctOf(roundTripFeeBp("rtoken", DEFAULT_FEES))} to buy and sell the tokenized stock,
        {" "}{pctOf(roundTripFeeBp("perp", DEFAULT_FEES))} for the perpetual.
      </footer>
    </div>
  );
}

function Chip({ k, v, found }: { k: string; v: string; found: boolean }) {
  return <span className={`chip ${found ? "found" : "assumed"}`}><em>{k}</em> {v}</span>;
}

function Verdict({ quote, notional, split }: { quote: Quote; notional: number; split: SplitPlan | null }) {
  const best = quote.routes.find((r) => r.rank === 1);
  const second = quote.routes.find((r) => r.rank === 2);
  // The other wrapper, when it could not be priced at this amount, and the reason why.
  const blocked = quote.routes.find(
    (r) => r.route !== "stockplus" && r.rank === null && (r.status === "no_book" || r.status === "cannot_fill"),
  );

  // Too big for either book alone, but fillable across both. Saying "no way" would be false.
  if (!best && split?.worthIt && split.bestSingle === null) {
    return (
      <div className="verdict only">
        <strong>Neither can take all ${notional.toLocaleString()} alone. Split it across both.</strong>
        <span>The split below fills the whole order from the two live books together.</span>
      </div>
    );
  }

  // A split that beats the best single route is the answer, so it leads.
  if (best && split?.worthIt && split.bestSingle) {
    return (
      <div className="verdict">
        <strong>Split it across both. It saves you {usdAmount(split.savingUsd)}.</strong>
        <span>
          {usdAmount(split.perpUsd)} through the perpetual and {usdAmount(split.tokenUsd)} through the
          tokenized stock, about {usdAmount(split.totalUsd)} in total on ${notional.toLocaleString()} of{" "}
          {quote.intent.ticker}.
        </span>
      </div>
    );
  }

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
        <strong>
          {blocked
            ? `Only ${theRoute(best.route)} can be priced at $${notional.toLocaleString()} right now.`
            : `Only one option works: ${theRoute(best.route)}.`}
        </strong>
        <span>
          {blocked
            ? blocked.reason ?? ""
            : "Nothing else can do what you asked."}
        </span>
      </div>
    );
  }

  const diff = second.totalBp!.mid - best.totalBp!.mid;
  /*
   * If the funding forecast could put the runner up ahead, the ranking is not settled, and the
   * headline says so. It only is when the two cost ranges
   * overlap: a band wider than the gap does not matter if even the runner up's best case costs
   * more than the leader's worst.
   */
  const widestBand = Math.max(
    ...quote.routes.map((r) => (r.fundingBp ? r.fundingBp.high - r.fundingBp.low : 0)),
  );
  if (unsettled(quote)) {
    return (
      <div className="verdict unsettled">
        <strong>Too close to call.</strong>
        <span>
          {TheRoute(best.route)} is ahead by {usd(diff, notional)}, but funding on
          the perpetual could move the result by {usd(widestBand, notional)} over{" "}
          {quote.intent.horizonDays} days. The trading costs are firm; funding is a forecast.
        </span>
      </div>
    );
  }

  return (
    <div className="verdict">
      <strong>Use {theRoute(best.route)}. It saves you {usd(diff, notional)}.</strong>
      <span>
        On ${notional.toLocaleString()} of {quote.intent.ticker}, held {quote.intent.horizonDays} days.
        {" "}
        {quote.horizonDecides
          ? "Their trading costs are close, so funding on the perpetual decides it."
          : "What decides it is the cost of getting in and back out, not the holding period."}
      </span>
    </div>
  );
}

/** True when the funding forecast could reverse the ranking: the two cost ranges overlap. */
function unsettled(quote: Quote): boolean {
  const a = quote.routes.find((r) => r.rank === 1);
  const b = quote.routes.find((r) => r.rank === 2);
  if (!a?.totalBp || !b?.totalBp) return false;
  return b.totalBp.low < a.totalBp.high;
}

/** How much separates the best two ranked routes, which is what the answer turns on. */
function decisionGap(quote: Quote): number | null {
  const a = quote.routes.find((r) => r.rank === 1);
  const b = quote.routes.find((r) => r.rank === 2);
  if (!a?.totalBp || !b?.totalBp) return null;
  return b.totalBp.mid - a.totalBp.mid;
}

/**
 * The session chart can only show sizes the sampler actually walked, for this ticker.
 *
 * Both parts matter. Interpolating between measured sizes would invent a number, and picking
 * the arithmetically nearest size regardless of coverage empties the chart: $500 and $50,000
 * were added late, so a $1,000 request snapped to $500 and found nothing, on a ticker with
 * four days of history at $2,000.
 *
 * So: nearest among the sizes that actually have data for this ticker. Live pricing always
 * uses the exact amount; this is only about the historical medians.
 */
function nearestSize(ticker: string, n: number): number {
  const file = outlookData as OutlookFile;
  const entry = (file.tickers as Record<string, Record<string, Record<string, { bp: Record<string, number | null> }>>>)[ticker];
  const covered = (file.sizes ?? SIZES).filter((size) => {
    for (const route of ["rtoken", "perp"]) {
      for (const sess of Object.values(entry?.[route] ?? {})) {
        if (typeof sess?.bp?.[String(size)] === "number") return true;
      }
    }
    return false;
  });
  const pool = covered.length ? covered : (file.sizes ?? SIZES);
  return pool.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
}
