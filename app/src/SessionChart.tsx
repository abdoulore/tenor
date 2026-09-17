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
const PAD = { top: 28, right: 24, bottom: 56, left: 56 };

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
  const series = (["rtoken", "perp"] as const).map((route) => ({
    route,
    label: route === "rtoken" ? "rToken" : "Perp",
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
    return <section className="chart"><p className="empty-note">No samples for this ticker yet.</p></section>;
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
      <h2>What it costs to get in and out, by hour</h2>
      <p className="sub">
        Round trip execution on ${size.toLocaleString()}, median of every sample in each session.
        Fees and funding are not in this chart.
      </p>

      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Execution cost by session">
        {tickValues.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="grid" />
            <text x={PAD.left - 10} y={y(v) + 4} className="axis" textAnchor="end">
              {step < 1 ? v.toFixed(1) : v.toFixed(0)}
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
                      {p.empty ? "no book" : "no data"}
                    </text>
                  </g>
                ) : (
                  <g key={i}>
                    <circle cx={x(i)} cy={y(p.bp)} r={6} className="dot" />
                    <text x={x(i)} y={y(p.bp) - 14} className="value" textAnchor="middle">
                      {p.bp.toFixed(1)}
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
            <i /> {s.label}
          </span>
        ))}
        {/* Count samples that actually had a book. "413 rToken samples" beside four
            no-book marks reads as data supporting a line that is not there. */}
        <span className="samples">
          {withBook(series[0].points)} rToken samples with a book,{" "}
          {withBook(series[1].points)} perp
        </span>
      </div>
    </section>
  );
}
