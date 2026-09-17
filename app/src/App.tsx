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
import { DEFAULT_FEES, feeGapBp, roundTripFeeBp } from "../../engine/fees.ts";
import { crossoverDays } from "../../engine/funding.ts";
import type { Book, Intent, Quote, RouteResult, Session, SessionOutlook } from "../../engine/types.ts";
import type { Settlement } from "../../engine/funding.ts";
import { getParser } from "./parse.ts";
import outlookData from "./data/outlook.json";
import { SessionChart } from "./SessionChart.tsx";
import { BreakEven } from "./BreakEven.tsx";

const SESSIONS: Session[] = ["premarket", "regular", "afterhours", "overnight"];
const SIZES = [2_000, 10_000];

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

const fmtBp = (x: number | null | undefined, dp = 2) =>
  x === null || x === undefined ? "n/a" : `${x.toFixed(dp)}bp`;

const usd = (bp: number, notional: number) => `$${((bp / 10_000) * notional).toFixed(2)}`;

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
  no_book: { title: "No order book", tone: "dead" },
  cannot_fill: { title: "Too big for the book", tone: "warn" },
  ineligible: { title: "Cannot express this", tone: "dead" },
  modeled: { title: "Modeled, not ranked", tone: "muted" },
  stale: { title: "Stale data", tone: "warn" },
};

function RouteCard({
  r, notional, best, horizonDays, decisionBp,
}: {
  r: RouteResult; notional: number; best: boolean; horizonDays: number;
  /** How far apart the two live routes are. The yardstick the funding band is judged against. */
  decisionBp: number | null;
}) {
  const copy = STATUS_COPY[r.status];
  const priced = r.totalBp !== null;
  const certain = (r.feeBp ?? 0) + (r.executionBp ?? 0);
  const bandWidth = r.fundingBp ? r.fundingBp.high - r.fundingBp.low : 0;
  // A band wider than the gap it is meant to resolve cannot resolve it.
  const wideBand = decisionBp !== null && bandWidth > Math.abs(decisionBp);
  return (
    <div className={`route ${best ? "best" : ""} ${copy?.tone ?? "ok"}`}>
      <div className="route-head">
        <span className="route-name">{r.label}</span>
        {best && <span className="badge">cheapest</span>}
        {copy && <span className={`badge ${copy.tone}`}>{copy.title}</span>}
      </div>

      {priced ? (
        <>
          {/*
            * The headline is what is actually known: fees and execution, both measured now.
            * Funding is projected and gets its own line with its range, because folding a
            * 257bp band into one confident number is the one thing here a reader could
            * fairly call dishonest.
            */}
          <div className="route-total">
            <strong>{fmtBp(certain)}</strong>
            <span className="sub"> {usd(certain, notional)}</span>
            <span className="band"> to get in and out</span>
          </div>
          <div className="breakdown">
            <span>fee {fmtBp(r.feeBp)}</span>
            <span className={`prov ${r.feeProvenance}`}>{r.feeProvenance}</span>
            <span>execution {fmtBp(r.executionBp)}</span>
          </div>

          {r.route === "perp" && r.fundingBp && (
            <div className={`funding ${wideBand ? "wide" : ""}`}>
              <span className="fl">plus funding over {horizonDays}d</span>
              <span className="fv">
                {fmtBp(r.fundingBp.mid)}
                {bandWidth > 0.005 && (
                  <em> anywhere from {fmtBp(r.fundingBp.low)} to {fmtBp(r.fundingBp.high)}</em>
                )}
              </span>
            </div>
          )}

          {r.route === "perp" && r.totalBp && (
            <div className="route-sum">
              total <strong>{fmtBp(r.totalBp.mid)}</strong>
              {bandWidth > 0.005 && <span> ({fmtBp(r.totalBp.low)} to {fmtBp(r.totalBp.high)})</span>}
            </div>
          )}

          {wideBand && (
            <div className="note loud">
              The cost of this route depends almost entirely on funding, and funding is not
              predictable at {horizonDays} days. The band above is wider than the difference
              between the routes, so treat the ranking as unsettled.
            </div>
          )}

          {r.absorbableUsd !== null && r.absorbableUsd < notional * 3 && (
            <div className="note">Book holds about ${r.absorbableUsd.toLocaleString()} on the thinner side.</div>
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
  const [parseInfo, setParseInfo] = useState<{ found: string[]; assumed: string[]; parser: string; note?: string } | null>(null);
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
  const [now, setNow] = useState(Date.now());

  const parser = useMemo(() => getParser(), []);
  const session = useMemo(() => sessionLabel(new Date(now)) as Session, [now]);
  const reqId = useRef(0);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { listTickers().then(setTickers).catch(() => setTickers([])); }, []);

  const run = useCallback(async (override?: Partial<Intent>) => {
    const id = ++reqId.current;
    setStatus("loading");
    setError(null);
    try {
      const parsed = await parser.parse(text, tickers.length ? tickers : ["NVDA", "MSFT", "SOXL", "AAOI", "HOOD"]);
      const nextIntent: Intent = { ...parsed.intent, ...override };
      if (override?.constraints) nextIntent.constraints = { ...parsed.intent.constraints, ...override.constraints };
      if (!nextIntent.ticker) throw new Error("No ticker recognised. Name a US stock, for example NVDA.");

      setParseInfo({ found: parsed.found, assumed: parsed.assumed, parser: parsed.parser, note: parsed.note });
      setIntent(nextIntent);

      const p = await resolvePair(nextIntent.ticker);
      if (id !== reqId.current) return;
      if (!p) throw new Error(`${nextIntent.ticker} does not have both an rToken and a stock perp on Bitget.`);
      setPair(p);

      const [spotRes, perpRes, fundRes] = await Promise.allSettled([
        fetchBook("SPOT", p.spotSymbol),
        fetchBook("USDT-FUTURES", p.perpSymbol),
        fetchFunding(p.perpSymbol),
      ]);
      if (id !== reqId.current) return;

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
      setStatus("idle");
    } catch (e) {
      if (id !== reqId.current) return;
      setError((e as Error).message);
      setStatus("error");
      setQuote(null);
    }
  }, [parser, text, tickers]);

  // Re-price whenever anything it depends on moves. Pricing is pure and cheap, so this is
  // recomputed rather than cached, which keeps the staleness indicator honest.
  useEffect(() => {
    if (!intent || !books || !pair) return;
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
  }, [intent, books, pair, funding, session, fellBackAt, now]);

  useEffect(() => { if (tickers.length) void run(); /* first paint once tickers land */ }, [tickers.length]);

  const outlook = intent ? outlookFor(intent.ticker, nearestSize(intent.notionalUsd)) : null;
  const coverage = (outlookData as OutlookFile).coverage;

  return (
    <div className="page">
      <header>
        <div className="brand">
          <h1>Tenor</h1>
          <p>Can you trade it, at your size, at this hour, for how long.</p>
        </div>
        <div className="live">
          <span className={`dot ${session}`} /> {session}
          <span className="sep" />
          fee gap {Math.abs(feeGapBp(DEFAULT_FEES)).toFixed(2)}bp toward the{" "}
          {feeGapBp(DEFAULT_FEES) < 0 ? "rToken" : "perp"}
        </div>
      </header>

      <section className="intent">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run(); }}
          rows={2}
          placeholder="$2,000 of NVDA for a month, no leverage"
        />
        <button onClick={() => void run()} disabled={status === "loading"}>
          {status === "loading" ? "Pricing" : "Price it"}
        </button>
      </section>

      {parseInfo && intent && (
        <section className="parsed">
          <span className="label">Read as</span>
          <Chip k="ticker" v={intent.ticker} found={parseInfo.found.includes("ticker")} />
          <Chip k="size" v={`$${intent.notionalUsd.toLocaleString()}`} found={parseInfo.found.includes("size")} />
          <Chip k="direction" v={intent.direction} found={parseInfo.found.includes("direction")} />
          <Chip k="horizon" v={`${intent.horizonDays}d`} found={parseInfo.found.includes("horizon")} />
          <Chip k="leverage" v={`${intent.constraints.leverage}x`} found={parseInfo.found.includes("leverage")} />
          {intent.constraints.wantsDividends && <Chip k="wants" v="dividends" found />}
          {intent.constraints.wantsVoting && <Chip k="wants" v="voting" found />}
          {intent.constraints.needsOffHoursExit && <Chip k="needs" v="off hours exit" found />}
          <span className="parser">{parseInfo.parser === "model" ? "parsed by model" : "parsed by rules"}</span>
          {parseInfo.assumed.length > 0 && (
            <span className="assumed">assumed: {parseInfo.assumed.join(", ")}. Edit the text to correct.</span>
          )}
          {parseInfo.note && <span className="assumed">{parseInfo.note}</span>}
        </section>
      )}

      {error && <section className="error"><strong>Cannot price this.</strong> {error}</section>}

      {quote && intent && (
        <>
          <nav className="tabs">
            <button className={tab === "routes" ? "on" : ""} onClick={() => setTab("routes")}>Routes</button>
            <button className={tab === "sessions" ? "on" : ""} onClick={() => setTab("sessions")}>By hour</button>
            {quote.horizonDecides && (
              <button className={tab === "breakeven" ? "on" : ""} onClick={() => setTab("breakeven")}>Break-even</button>
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
                />
              ))}
              {(["rtoken", "perp"] as const).map((route) => {
                const b = outlook ? betterSession(outlook[route], session) : null;
                return b ? (
                  <div className="hint" key={route}>
                    {route === "rtoken" ? "rToken" : "Perp"} is {b.savingBp.toFixed(2)}bp cheaper in{" "}
                    <strong>{b.session}</strong> than right now, on sampled medians.
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
            <button onClick={() => void run({ horizonDays: 7 })}>I hold a week</button>
            <button onClick={() => void run({ horizonDays: 90 })}>I hold 90 days</button>
            <button onClick={() => void run({ notionalUsd: intent.notionalUsd * 5 })}>I size up 5x</button>
            <button onClick={() => void run({ direction: intent.direction === "long" ? "short" : "long",
              constraints: { ...intent.constraints, needsShort: intent.direction === "long" } })}>
              I flip direction
            </button>
          </section>

          <section className="warnings">
            {quote.warnings.map((w) => <div key={w} className="warn-line">{w}</div>)}
            {fetchedAt && (
              <div className="warn-line">
                {fellBackAt !== null
                  ? `Bitget did not answer, so these are the last good books, ${Math.round((now - fellBackAt) / 1000)}s old.`
                  : `Books fetched live ${Math.round((now - fetchedAt) / 1000)}s ago.`}
                {" "}Session medians from {coverage.records.toLocaleString()} samples over{" "}
                {coverage.cycles} cycles, {String(coverage.from).slice(0, 16)} to {String(coverage.to).slice(0, 16)}.
                {" "}That is about a day of data, not a quarter.
              </div>
            )}
          </section>
        </>
      )}

      <footer>
        Deterministic cost engine. rToken round trip {roundTripFeeBp("rtoken", DEFAULT_FEES).toFixed(2)}bp,
        perp {roundTripFeeBp("perp", DEFAULT_FEES).toFixed(2)}bp. No figure on this page is generated by a model.
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
    return <div className="verdict none"><strong>Nothing can trade this right now.</strong>
      <span>Every route is ruled out. The reasons are below.</span></div>;
  }
  if (!second) {
    return (
      <div className="verdict only">
        <strong>{best.label} is the only route.</strong>
        <span>{dead ? `${dead.label} has no order book at all, so there is nothing to compare.` : "Nothing else can express this."}</span>
      </div>
    );
  }
  const diff = second.totalBp!.mid - best.totalBp!.mid;
  // If either route's funding band is wider than the gap between them, the ranking is a
  // coin toss dressed up as an answer. Say so in the headline rather than the footnotes.
  const widestBand = Math.max(
    ...quote.routes.map((r) => (r.fundingBp ? r.fundingBp.high - r.fundingBp.low : 0)),
  );
  if (widestBand > Math.abs(diff)) {
    return (
      <div className="verdict unsettled">
        <strong>Too close to call, and funding is why.</strong>
        <span>
          {best.label} leads by {diff.toFixed(2)}bp, but funding over{" "}
          {quote.intent.horizonDays} days could move the answer by {widestBand.toFixed(0)}bp.
          Getting in and out is the only part anyone can price today.
        </span>
      </div>
    );
  }
  return (
    <div className="verdict">
      <strong>{best.label} by {diff.toFixed(2)}bp.</strong>
      <span>
        That is {usd(diff, notional)} on ${notional.toLocaleString()}, decided by{" "}
        {quote.horizonDecides ? "how long you hold it" : "what it costs to get in and out"}.
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
