/**
 * The share behind the token.
 *
 * Reads the real share price, past dividends and past earnings dates from Bitget's market data
 * service, through /api/equity, and says three things: how the tokenized stock is priced against
 * the share, whether a dividend is likely inside the holding period, and whether an earnings
 * report is. Future dates are projected from past ones and labelled that way every time.
 */

import { useEffect, useState } from "react";
import { shareOutlook, type ShareFacts as Facts } from "../../engine/equity.ts";
import type { Session } from "../../engine/types.ts";

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

export function ShareFacts({
  ticker, tokenMid, horizonDays, notional, session,
}: {
  ticker: string;
  tokenMid: number | null;
  horizonDays: number;
  notional: number;
  session: Session;
}) {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let live = true;
    setState("loading");
    setFacts(null);
    fetch(`/api/equity?symbol=${encodeURIComponent(ticker)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => { if (live) { setFacts(j); setState("ready"); } })
      .catch(() => { if (live) setState("error"); });
    return () => { live = false; };
  }, [ticker]);

  if (state === "loading") return <section className="share"><p className="note">Reading the share price from Bitget&hellip;</p></section>;
  if (state === "error" || !facts) {
    return <section className="share"><p className="note">Bitget's market data service did not answer, so there is nothing to add about the share itself.</p></section>;
  }

  const out = shareOutlook(facts, tokenMid, Date.now(), horizonDays);
  const open = session === "regular";
  const prem = out.premiumBp;

  return (
    <section className="share">
      <h3>The share itself</h3>

      {facts.price ? (
        <p>
          {ticker} last traded at <strong>${facts.price.last.toFixed(2)}</strong> on the US market.{" "}
          {prem === null
            ? "There is no live price for the tokenized stock to compare it with."
            : Math.abs(prem) < 5
              ? <>The tokenized stock is priced <strong>in line</strong> with it.</>
              : <>The tokenized stock is priced <strong>{Math.abs(prem / 100).toFixed(2)}% {prem > 0 ? "above" : "below"}</strong> it.</>}
          {!open && prem !== null && " US markets are closed, so that compares against the last trade."}
        </p>
      ) : (
        <p className="note">No share price is available for {ticker}.</p>
      )}

      {out.nextDividend ? (
        <p>
          Next dividend: {out.nextDividend.announced ? "announced for " : "around "}<strong>{fmtDate(out.nextDividend.date)}</strong>, about $
          {out.nextDividend.amount.toFixed(2)} a share
          {out.nextDividend.yieldPct !== null && <>, or <strong>${((out.nextDividend.yieldPct / 100) * notional).toFixed(2)}</strong> on your ${notional.toLocaleString()}</>}.{" "}
          {out.nextDividend.inHorizon ? <strong>That falls inside your {horizonDays} days.</strong> : `That is after your ${horizonDays} days.`}{" "}
          <span className="dim">We have not confirmed whether either Bitget wrapper passes dividends on.</span>
        </p>
      ) : facts.dividends.length === 0 ? (
        <p className="dim">{ticker} has no dividend history in Bitget's data.</p>
      ) : null}

      {out.nextEarnings && (
        <p>
          Next earnings report: {out.nextEarnings.announced ? "announced for " : "around "}<strong>{fmtDate(out.nextEarnings.date)}</strong>.{" "}
          {out.nextEarnings.inHorizon ? <strong>That falls inside your {horizonDays} days.</strong> : `That is after your ${horizonDays} days.`}
        </p>
      )}

      <p className="note">
        From Bitget's market data service. Dates marked "around" are projected from the company's
        own past dates, not announced, and records that cannot be right are left out.
      </p>
    </section>
  );
}
