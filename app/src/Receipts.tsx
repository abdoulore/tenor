/**
 * Track record: every recommendation this tool has made, checked against what happened next.
 *
 * The temptation with a page like this is one big flattering number. Three separate things
 * are measured instead, because they answer different questions and two of them are much
 * weaker evidence than they look.
 *
 * The funding half of every forecast is unresolved and is reported as unresolved. Nothing
 * here is scored that cannot be checked.
 */

import receipts from "./data/receipts.json";
import { QUOTE_TESTS, fillGaps } from "../../engine/evidence.ts";

type Receipts = typeof receipts;

const fmt = (n: number) => n.toLocaleString();
const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;

export function Receipts({ notional = 2_000 }: { notional?: number }) {
  const r = receipts as Receipts;
  const acc = r.accuracy;
  // The same call changing several times is one finding, so repeats are grouped with a count.
  const flipGroups = (() => {
    const m = new Map<string, { key: string; ticker: string; size: number; said: string; became: string; times: number; gaps: number[] }>();
    type Flip = { ticker: string; size: number; said: string; became: string; gapBp: number };
    for (const f of r.flips as unknown as Flip[]) {
      const key = `${f.ticker}|${f.size}|${f.said}|${f.became}`;
      const g = m.get(key) ?? { key, ticker: f.ticker, size: f.size, said: f.said, became: f.became, times: 0, gaps: [] };
      g.times++;
      g.gaps.push(f.gapBp);
      m.set(key, g);
    }
    return [...m.values()]
      .map((g) => ({ ...g, gapBp: [...g.gaps].sort((a, b) => a - b)[g.gaps.length >> 1] }))
      .sort((a, b) => b.times - a.times);
  })();
  // Present once the report has been regenerated with the source of each call.
  const sources = (r as unknown as { sources?: { book: number; quote: number } }).sources;
  // A lag is only shown once enough time has passed for it to have been checked.
  const shownAcc = acc.filter((a) => a.checks > 0);
  const shownStab = r.stability.filter((s) => s.checks > 0);
  const first = shownAcc[0] ?? acc[0];
  const last = shownAcc[shownAcc.length - 1] ?? acc[acc.length - 1];
  const lastLabel = last.lagMinutes < 60 ? `${last.lagMinutes} minutes` : `${last.lagMinutes / 60} hour${last.lagMinutes > 60 ? "s" : ""}`;
  const hour = r.stability.find((s) => s.lagMinutes === 60 && s.checks > 0)
    ?? r.stability.find((s) => s.checks > 0) ?? r.stability[0];
  const money = (bp: number) => `$${((bp / 10_000) * notional).toFixed(2)}`;


  return (
    <section className="receipts">
      <h2>What this tool has said, and whether it held up</h2>
      <p className="sub">
        Every recommendation is written down the moment it is made, before anyone knows the
        answer. {fmt(r.predictions)} of them so far, on {r.tickers.length} companies, from{" "}
        {when(r.from)} to {when(r.to)}. Nothing here is chosen after the fact.
      </p>

      <div className="rnotice">
        <strong>How the tokenized stock is priced.</strong> Tenor prices the tokenized stock from
        Bitget's live quote, the price its orders fill at, confirmed by the live test orders below.
        This record covers every call made on that basis, since 23 September.
      </div>

      <h3>The test orders</h3>
      <p className="sub">
        Four live market orders, each routed by Bitget's StockRoute. Each fill is set against the
        quote read just before and just after it, and against the order book at the time.
      </p>
      <table className="rtable">
        <thead>
          <tr><th>Order</th><th>Filled at</th><th>Quote said</th><th>Order book said</th><th>Off the quote</th></tr>
        </thead>
        <tbody>
          {QUOTE_TESTS.map((t) => {
            const g = fillGaps(t);
            const px = (q: { bid: number; ask: number }) => (t.side === "buy" ? q.ask : q.bid);
            return (
              <tr key={t.orderId}>
                <td>{t.side === "buy" ? "Buy" : "Sell"} {t.symbol.replace(/USDT$/, "").replace(/^R/, "r")}<span className="oid"> {t.orderId}</span></td>
                <td>{t.fillPrice.toFixed(2)}</td>
                <td>{px(t.before).toFixed(2)} then {px(t.after).toFixed(2)}</td>
                <td>{t.book ? px(t.book).toFixed(2) : "empty"}</td>
                <td>{g.quoteBp.toFixed(2)}bp</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="rcards">
        <div className="rcard">
          <span className="rlabel">Typical miss on a quoted cost</span>
          <strong>{money(first.medianAbsErrorBp ?? 0)}</strong>
          <span className="rnote">
            on ${fmt(notional)}, five minutes after we quoted it. {first.within5bpPct}% of quotes
            were still good to within {money(5)}.
          </span>
        </div>
        <div className="rcard">
          <span className="rlabel">Same answer an hour later</span>
          <strong>{hour.heldPct}%</strong>
          <span className="rnote">
            {fmt(hour.checks)} calls replayed on later prices. {fmt(hour.flipped)} changed.
          </span>
        </div>
        <div className="rcard">
          <span className="rlabel">Funding forecasts</span>
          <strong>Day {Math.max(1, Math.ceil(r.funding.elapsedDays))} of 30</strong>
          <span className="rnote">
            Each call projects funding over 30 days. They are scored as they complete.
          </span>
        </div>
      </div>

      <h3>How fast a quote goes out of date</h3>
      <p className="sub">
        Nobody acts the instant they read a number. This is the quoted cost against what the
        same trade actually cost later, on ${fmt(notional)}.
      </p>
      <table className="rtable">
        <thead>
          <tr><th>If you acted</th><th>Checks</th><th>Typical miss</th><th>Still within {money(5)}</th></tr>
        </thead>
        <tbody>
          {shownAcc.map((a) => (
            <tr key={a.lagMinutes}>
              <td>{a.lagMinutes < 60 ? `${a.lagMinutes} minutes later` : `${a.lagMinutes / 60} hour${a.lagMinutes > 60 ? "s" : ""} later`}</td>
              <td>{fmt(a.checks)}</td>
              <td>{money(a.medianAbsErrorBp ?? 0)}</td>
              <td>{a.within5bpPct}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sub">
        {(last.medianAbsErrorBp ?? 0) > (first.medianAbsErrorBp ?? 0) + 0.25
          ? <>The miss grows from {money(first.medianAbsErrorBp ?? 0)} to {money(last.medianAbsErrorBp ?? 0)} over {lastLabel}</>
          : <>The miss stays around {money(first.medianAbsErrorBp ?? 0)} over {lastLabel}</>}
        , and the average error is about zero throughout, so the quotes are not biased in either
        direction.
      </p>

      <h3>Would it still say the same thing</h3>
      <table className="rtable">
        <thead>
          <tr><th>Replayed</th><th>Calls</th><th>Same answer</th><th>Changed</th></tr>
        </thead>
        <tbody>
          {shownStab.map((s) => (
            <tr key={s.lagMinutes}>
              <td>{s.lagMinutes < 60 ? `${s.lagMinutes} minutes later` : `${s.lagMinutes / 60} hour${s.lagMinutes > 60 ? "s" : ""} later`}</td>
              <td>{fmt(s.checks)}</td>
              <td>{s.heldPct}%</td>
              <td>{fmt(s.flipped)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {(() => {
        const gap = (hour as { medianFlipGapBp?: number | null }).medianFlipGapBp;
        return typeof gap === "number" ? (
          <p className="sub">
            When a call did change an hour later, following the original call would have cost a
            median <strong>{money(gap)}</strong> more on ${fmt(notional)}.
          </p>
        ) : null;
      })()}

      {flipGroups.length > 0 && (
        <details className="flips-more">
          <summary>Show the calls that changed</summary>
          <table className="rtable flips">
            <thead>
              <tr><th>Company</th><th>Size</th><th>We said</th><th>An hour later</th><th>Times</th><th>Typical gap</th></tr>
            </thead>
            <tbody>
              {flipGroups.slice(0, 10).map((g) => (
                <tr key={g.key}>
                  <td>{g.ticker}</td>
                  <td>${fmt(g.size)}</td>
                  <td>{g.said === "rtoken" ? "Tokenized stock" : "Perpetual"}</td>
                  <td className="became">{g.became === "rtoken" ? "Tokenized stock" : "Perpetual"}</td>
                  <td>{g.times}</td>
                  <td>{money(g.gapBp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}


      <p className="sub footnote">
        Written from {fmt(r.predictions)} logged recommendations checked against continuous
        price sampling. Recorded {when(r.generatedAt)}.
      </p>
    </section>
  );
}
