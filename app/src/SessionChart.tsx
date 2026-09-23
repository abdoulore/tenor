/**
 * Cost across the four US sessions, both legs, current hour marked.
 *
 * This is the demo centrepiece, so it has to read on a projector: thick strokes, large type,
 * no hover-only information. An empty book is drawn as a gap with a label rather than a zero,
 * because zero would read as free and the truth is that it cannot be traded at all.
 *
 * Inline SVG, no charting dependency.
 */

import type { Session, SessionOutlook } from "../../engine/types.ts";

const SESSIONS: Session[] = ["premarket", "regular", "afterhours", "overnight"];
const LABELS: Record<string, string> = {
  premarket: "Pre-market",
  regular: "US hours",
  afterhours: "After-hours",
  overnight: "Overnight",
};

const W = 760;
const H = 320;
const PAD = { top: 28, right: 24, bottom: 56, left: 78 };

/** Round an axis up to a 1, 2 or 5 times a power of ten, so ticks land on readable values. */
function niceScale(rawMax: number, targetTicks = 5): { max: number; step: number } {
  if (!(rawMax > 0)) return { max: 1, step: 0.2 };
  const rough = rawMax / (targetTicks - 1);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(rawMax / step) * step, step };
}

function withBook(points: { samples: number; empty: boolean; bp: number | null }[]): string {
  const n = points.reduce((t, p) => t + (p.bp === null ? 0 : p.samples), 0);
  return n.toLocaleString();
}

export function SessionChart({
  outlook,
  current,
  size,
  requested,
  ticker,
}: {
  outlook: Record<"rtoken" | "perp" | "stockplus", SessionOutlook[]>;
  current: Session;
  /** A size the sampler actually walked. */
  size: number;
  /** What the user asked for, which may not be one of those. */
  requested: number;
  ticker: string;
}) {
  // Dollars on the amount asked about, because a basis point means nothing to most people.
  const money = (bp: number) => {
    const d = (bp / 10_000) * size;
    return `$${d.toLocaleString(undefined, { minimumFractionDigits: d < 100 ? 2 : 0, maximumFractionDigits: d < 100 ? 2 : 0 })}`;
  };
  const series = (["rtoken", "perp"] as const).map((route) => ({
    route,
    label: route === "rtoken" ? "Tokenized stock" : "Perpetual futures",
    points: SESSIONS.map((s) => {
      const e = outlook[route].find((o) => o.session === s);
      return {
        session: s,
        bp: e?.executionBp ?? null,
        empty: e ? e.emptyShare === 1 : false,
        samples: e?.samples ?? 0,
      };
    }),
  }));

  const values = series.flatMap((s) => s.points.map((p) => p.bp).filter((v): v is number => v !== null));
  if (!values.length) {
    return (
      <section className="chart">
        <p className="empty-note">
          We have not been watching this one long enough to say anything about the best hour to trade it.
        </p>
      </section>
    );
  }

  // Sane ticks. The old axis divided the raw maximum into four, which produced labels like
  // 10 8 5 3 0 that collide, and 3 2 1 1 0 that repeat a value.
  const { max, step } = niceScale(Math.max(...values));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (innerW / (SESSIONS.length - 1)) * i;
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;

  /*
   * The sentence the chart is for.
   *
   * It is computed rather than asserted, because the honest conclusion differs by ticker.
   * NVDA ranges from $1.28 to $1.50 across the day, which is nearly flat, while ABNB swings
   * twelvefold. A fixed headline claiming the hour matters would be wrong on the first and
   * wasted on the second.
   */
  const takeaway = (() => {
    const priced = series.map((ser) => ({
      route: ser.route,
      label: ser.route === "rtoken" ? "tokenized stock" : "perpetual",
      vals: ser.points.map((p) => p.bp).filter((v): v is number => v !== null),
      byBest: [...ser.points].filter((p) => p.bp !== null).sort((a, b) => a.bp! - b.bp!),
    })).filter((ser) => ser.vals.length >= 2);
    if (!priced.length) return null;

    const parts: string[] = [];
    // Quote recording began on 23 September, so for a while only the perpetual has a full day.
    const onlyPerp = priced.length === 1 && priced[0].route === "perp";
    if (onlyPerp) {
      parts.push("Only the perpetual has been measured through the day so far. The tokenized stock's quote has been recorded since 23 September and its hours fill in as it builds up.");
    }

    // Does the hour actually matter for this ticker, and by how much.
    const swings = priced.map((ser) => {
      const lo = Math.min(...ser.vals);
      const hi = Math.max(...ser.vals);
      return { ...ser, lo, hi, ratio: lo > 0 ? hi / lo : 1 };
    }).sort((a, b) => b.ratio - a.ratio);
    const worst = swings[0];

    if (worst.ratio >= 1.4) {
      const best = worst.byBest[0];
      const dear = worst.byBest[worst.byBest.length - 1];
      parts.push(
        `The hour matters here: the ${worst.label} costs ${money(dear.bp!)} ` +
        `${LABELS[dear.session].toLowerCase()} against ${money(best.bp!)} ${LABELS[best.session].toLowerCase()}, ` +
        `${worst.ratio.toFixed(1)} times as much.`,
      );
    } else {
      parts.push(
        `The hour barely matters for ${onlyPerp ? `the ${ticker} perpetual` : ticker}: everything sits between ` +
        `${money(Math.min(...priced.flatMap((p) => p.vals)))} and ` +
        `${money(Math.max(...priced.flatMap((p) => p.vals)))}.`,
      );
    }

    // Which one is cheaper, and whether that ever changes.
    if (priced.length === 2) {
      const [a, b] = priced;
      const aWins = a.points ?? null;
      let aCheaper = 0;
      let bCheaper = 0;
      for (const sess of SESSIONS) {
        const av = series[0].points.find((p) => p.session === sess)?.bp;
        const bv = series[1].points.find((p) => p.session === sess)?.bp;
        if (av === null || bv === null || av === undefined || bv === undefined) continue;
        if (av < bv) aCheaper++; else if (bv < av) bCheaper++;
      }
      void aWins;
      if (aCheaper && !bCheaper) parts.push(`The ${a.label} is cheaper to trade at every hour we measured.`);
      else if (bCheaper && !aCheaper) parts.push(`The ${b.label} is cheaper to trade at every hour we measured.`);
      else if (aCheaper && bCheaper) parts.push(`Which is cheaper to trade changes with the hour.`);
    }

    return parts.join(" ");
  })();

  const tickValues: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) tickValues.push(v);
  const currentIdx = SESSIONS.indexOf(current);

  return (
    <section className="chart">
      <h2>What it costs to trade {ticker}, hour by hour</h2>
      <p className="sub">
        The round trip on ${size.toLocaleString()}: what you lose to the spread getting in and
        back out. Fees and funding are not in this chart. The tokenized stock is measured from
        Bitget's quote, which is what its orders fill at, and we started recording that on 23
        September, so some hours are not measured yet.
        {requested !== size && (
          <>
            {" "}You asked about ${requested.toLocaleString()}, and ${size.toLocaleString()} is the
            closest size we have actually measured, so that is what is shown here. The prices on
            your options tab use your real amount.
          </>
        )}
      </p>
      {takeaway && <p className="takeaway">{takeaway}</p>}

      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="What it costs to buy and sell at each time of day">
        {tickValues.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="grid" />
            <text x={PAD.left - 10} y={y(v) + 4} className="axis" textAnchor="end">
              {money(v)}
            </text>
          </g>
        ))}

        {currentIdx >= 0 && (
          <g>
            <line x1={x(currentIdx)} x2={x(currentIdx)} y1={PAD.top - 8} y2={PAD.top + innerH} className="nowline" />
            <text x={x(currentIdx)} y={PAD.top - 14} className="nowlabel" textAnchor="middle">now</text>
          </g>
        )}

        {series.map((s) => {
          // Break the line wherever a session has no measurement, so a gap stays a gap.
          const segs: { i: number; bp: number }[][] = [];
          let cur: { i: number; bp: number }[] = [];
          s.points.forEach((p, i) => {
            if (p.bp === null) { if (cur.length) segs.push(cur); cur = []; }
            else cur.push({ i, bp: p.bp });
          });
          if (cur.length) segs.push(cur);

          return (
            <g key={s.route} className={`series ${s.route}`}>
              {segs.map((seg, k) => (
                <polyline
                  key={k}
                  className="line"
                  points={seg.map((p) => `${x(p.i)},${y(p.bp)}`).join(" ")}
                />
              ))}
              {s.points.map((p, i) =>
                p.bp === null ? (
                  <g key={i}>
                    <line x1={x(i)} x2={x(i)} y1={PAD.top + innerH - 6} y2={PAD.top + innerH + 6} className="gapmark" />
                    <text x={x(i)} y={PAD.top + innerH - 14} className="gaptext" textAnchor="middle">
                      {p.empty ? "no price" : "not measured yet"}
                    </text>
                  </g>
                ) : (
                  <g key={i}>
                    <circle cx={x(i)} cy={y(p.bp)} r={6} className="dot" />
                    {/* Edge values anchor inward too, or the first one collides with the
                        axis label sitting a few pixels to its left. */}
                    <text
                      x={x(i)}
                      y={y(p.bp) - 14}
                      className="value"
                      textAnchor={i === 0 ? "start" : i === s.points.length - 1 ? "end" : "middle"}
                    >
                      {money(p.bp)}
                    </text>
                  </g>
                ),
              )}
            </g>
          );
        })}

        {SESSIONS.map((s, i) => (
          <text
            key={s}
            x={x(i)}
            y={H - 22}
            className={`xlabel ${s === current ? "on" : ""}`}
            textAnchor={i === 0 ? "start" : i === SESSIONS.length - 1 ? "end" : "middle"}
          >
            {LABELS[s]}
          </text>
        ))}
      </svg>

      <div className="legend">
        {series.map((s) => (
          <span key={s.route} className={`key ${s.route}`}>
            <i /> {s.route === "rtoken" ? "Tokenized stock" : "Perpetual futures"}
          </span>
        ))}
        {/* Count samples that actually had a book. "413 rToken samples" beside four
            no-book marks reads as data supporting a line that is not there. */}
        <span className="samples">
          Based on {withBook(series[0].points)} price checks for the tokenized stock and{" "}
          {withBook(series[1].points)} for the futures
        </span>
      </div>
    </section>
  );
}
