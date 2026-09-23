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

type Receipts = typeof receipts;

const fmt = (n: number) => n.toLocaleString();
const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;

export function Receipts({ notional = 2_000 }: { notional?: number }) {
  const r = receipts as Receipts;
  const acc = r.accuracy;
  const first = acc[0];
  const last = acc[acc.length - 1];
  const hour = r.stability.find((s) => s.lagMinutes === 60) ?? r.stability[0];
  const money = (bp: number) => `$${((bp / 10_000) * notional).toFixed(2)}`;

  // A perfect availability score means the dead markets never came back, not that anything
  // clever was predicted. The page has to say which, or the number flatters.
  const structural = r.availability.everChanged.length === 0;
  const deadNames = [...new Set(r.availability.deadNames.map((d) => d.split(":")[0]))];
  // Worked out from the log itself, so the sentence cannot go stale the way a typed-in
  // "two days" did once the log was a week old.
  const spanDays = Math.max(1, Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000));
  const listed = deadNames.length <= 1
    ? deadNames.join("")
    : `${deadNames.slice(0, -1).join(", ")} and ${deadNames[deadNames.length - 1]}`;

  return (
    <section className="receipts">
      <h2>What this tool has said, and whether it held up</h2>
      <p className="sub">
        Every recommendation is written down the moment it is made, before anyone knows the
        answer. {fmt(r.predictions)} of them so far, on {r.tickers.length} companies, from{" "}
        {when(r.from)} to {when(r.to)}. Nothing here is chosen after the fact.
      </p>

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
          <span className="rlabel">Still unresolved</span>
          <strong>{r.funding.elapsedDays} of 30 days</strong>
          <span className="rnote">
            Every forecast runs 30 days. None has finished, so the funding half of them cannot be judged yet.
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
          {acc.map((a) => (
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
        The miss grows from {money(first.medianAbsErrorBp ?? 0)} to{" "}
        {money(last.medianAbsErrorBp ?? 0)} over four hours, and the average error is about
        zero throughout, so the quotes are not drifting in one direction. They simply age.
      </p>

      <h3>Would it still say the same thing</h3>
      <table className="rtable">
        <thead>
          <tr><th>Replayed</th><th>Calls</th><th>Same answer</th><th>Changed</th></tr>
        </thead>
        <tbody>
          {r.stability.map((s) => (
            <tr key={s.lagMinutes}>
              <td>{s.lagMinutes < 60 ? `${s.lagMinutes} minutes later` : `${s.lagMinutes / 60} hour${s.lagMinutes > 60 ? "s" : ""} later`}</td>
              <td>{fmt(s.checks)}</td>
              <td>{s.heldPct}%</td>
              <td>{fmt(s.flipped)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {r.flips.length > 0 && (
        <>
          <h3>The ones that changed</h3>
          <p className="sub">
            These are the calls that would have been different an hour later. They are here
            because a track record that only shows its wins is not a track record.
          </p>
          <table className="rtable flips">
            <thead>
              <tr><th>Company</th><th>Size</th><th>We said</th><th>An hour later</th><th>By</th></tr>
            </thead>
            <tbody>
              {r.flips.slice(0, 12).map((f, i) => (
                <tr key={i}>
                  <td>{f.ticker}</td>
                  <td>${fmt(f.size)}</td>
                  <td>{f.said === "rtoken" ? "Tokenized stock" : "Perpetual"}</td>
                  <td className="became">{f.became === "rtoken" ? "Tokenized stock" : "Perpetual"}</td>
                  <td>{money(f.gapBp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="sub">
            Most of these are the same few wide, thinly traded names, where the two options sit
            within a few cents of each other and ordinary movement is enough to swap them. That
            is worth knowing: where the gap is small, the answer is genuinely unstable, and we
            would rather show you that than pretend otherwise.
          </p>
        </>
      )}

      <h3>Calls about what could be priced at all</h3>
      <p className="sub">
        We found no published depth {fmt(r.availability.saidDead)} times, and an hour later
        that was still the case {r.availability.deadStillDeadPct}% of the time. We found depth{" "}
        {fmt(r.availability.saidLive)} times, still there {r.availability.liveStillLivePct}% of
        the time an hour later.
      </p>
      {!structural && (
        <p className="caveat">
          {/*
            * Something did change state, so the score means more than it did when every
            * name simply had depth or did not all week. Name it, with times, rather than let a
            * 99.9% absorb it.
            */}
          Bitget either published depth for a token for the whole period or never did. The
          exception
          {(r.availability as { outages?: { ticker: string; from: string; to: string }[] }).outages?.length === 1 ? " was" : "s were"}{" "}
          {((r.availability as { outages?: { ticker: string; from: string; to: string }[] }).outages ?? [])
            .map((o) => `${o.ticker}, whose depth disappeared from Bitget's feed from ${o.from.slice(11, 16)} to ${o.to.slice(11, 16)} UTC on ${o.from.slice(0, 10)}`)
            .join("; ")}
          , then came back. None of this means those markets were closed: names without
          published depth still quote and trade, and their depth is simply not made public.
        </p>
      )}
      {structural && (
        <p className="caveat">
          Read that carefully rather than as a score. Of the {r.tickers.length} companies
          tracked, {deadNames.length === 1 ? `only ${listed} was` : `${listed} were`} ever
          found with no published depth, and not one changed state in {spanDays} days of checks
          every five minutes. So this is not evidence that we predict anything. It is evidence
          that Bitget either publishes depth for a token or does not, consistently. Those
          markets still quote and trade; their depth is simply not published.
        </p>
      )}

      <h3>What we cannot tell you yet</h3>
      <p className="caveat">{r.funding.note}</p>

      <p className="sub footnote">
        Written from {fmt(r.predictions)} logged recommendations checked against continuous
        price sampling. Recorded {when(r.generatedAt)}.
      </p>
    </section>
  );
}
