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
  premarket: "Before the open",
  regular: "US market hours",
  afterhours: "After the close",
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
}: {
  outlook: Record<"rtoken" | "perp" | "stockplus", SessionOutlook[]>;
  current: Session;
  size: number;
}) {
  // Dollars on the amount asked about, because a basis point means nothing to most people.
  const money = (bp: number) => {
    const d = (bp / 10_000) * size;
    return `$${d.toLocaleString(undefined, { minimumFractionDigits: d < 100 ? 2 : 0, maximumFractionDigits: d < 100 ? 2 : 0 })}`;
  };
  const series = (["rtoken", "perp"] as const).map((route) => ({
    route,
    label: route === "rtoken" ? "Tokenized stock" : "Futures contract",
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

  const tickValues: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) tickValues.push(v);
  const currentIdx = SESSIONS.indexOf(current);

  return (
    <section className="chart">
      <h2>The same trade costs different amounts at different hours</h2>
      <p className="sub">
        What you lose to the gap between buying and selling price, on ${size.toLocaleString()},
        typical across every check we have made. Bitget's fee and any holding fee are not in
        this chart, only the cost of getting in and back out.
      </p>

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
                      {p.empty ? "cannot trade" : "no data"}
                    </text>
                  </g>
                ) : (
                  <g key={i}>
                    <circle cx={x(i)} cy={y(p.bp)} r={6} className="dot" />
                    <text x={x(i)} y={y(p.bp) - 14} className="value" textAnchor="middle">
                      {money(p.bp)}
                    </text>
                  </g>
                ),
              )}
            </g>
          );
        })}

        {SESSIONS.map((s, i) => (
          <text key={s} x={x(i)} y={H - 22} className={`xlabel ${s === current ? "on" : ""}`} textAnchor="middle">
            {LABELS[s]}
          </text>
        ))}
      </svg>

      <div className="legend">
        {series.map((s) => (
          <span key={s.route} className={`key ${s.route}`}>
            <i /> {s.route === "rtoken" ? "Tokenized stock" : "Futures contract"}
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
