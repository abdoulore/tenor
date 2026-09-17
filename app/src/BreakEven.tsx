/**
 * Break-even: total cost against holding time, one line per route, crossover marked.
 *
 * This tab only appears when execution is inside the fee gap, which the prediction log puts
 * at about 5% of calls. Everywhere else execution already decided and a curve would imply a
 * choice that is not really open.
 *
 * The rToken line is flat, because spot pays its cost once. The perp line slopes, because
 * funding accrues. Where they cross is the answer.
 */

import { useMemo } from "react";
import { projectFunding, type Settlement } from "../../engine/funding.ts";
import type { Quote } from "../../engine/types.ts";

const W = 760;
const H = 300;
const PAD = { top: 24, right: 24, bottom: 48, left: 80 };
const MAX_DAYS = 120;

export function BreakEven({
  quote,
  funding,
  intervalHours,
}: {
  quote: Quote;
  funding: Settlement[];
  intervalHours: number;
}) {
  const rtoken = quote.routes.find((r) => r.route === "rtoken");
  const perp = quote.routes.find((r) => r.route === "perp");

  const curve = useMemo(() => {
    // Both routes need a real, live execution cost. Either one missing means there is no
    // comparison to draw, and drawing one anyway would invent the half that is absent.
    if (!rtoken || !perp) return null;
    if (rtoken.executionBp === null || perp.executionBp === null) return null;
    if (rtoken.totalBp === null || perp.totalBp === null) return null;

    const rtFixed = (rtoken.feeBp ?? 0) + (rtoken.executionBp ?? 0);
    const perpFixed = (perp.feeBp ?? 0) + (perp.executionBp ?? 0);

    const days = Array.from({ length: MAX_DAYS + 1 }, (_, d) => d);
    const perpAt = days.map((d) => {
      const p = projectFunding(funding, d, quote.intent.direction, { intervalHours });
      return { d, low: perpFixed + p.bp.low, mid: perpFixed + p.bp.mid, high: perpFixed + p.bp.high };
    });

    // The crossover is where the perp's central path passes the rToken's flat line.
    let cross: number | null = null;
    for (let i = 1; i < perpAt.length; i++) {
      const a = perpAt[i - 1].mid - rtFixed;
      const b = perpAt[i].mid - rtFixed;
      if (a === 0) { cross = perpAt[i - 1].d; break; }
      if (a < 0 !== b < 0) {
        cross = perpAt[i - 1].d + Math.abs(a) / (Math.abs(a) + Math.abs(b));
        break;
      }
    }
    return { rtFixed, perpAt, cross };
  }, [rtoken, perp, funding, intervalHours, quote.intent.direction]);

  if (!curve || !rtoken || !perp) {
    return (
      <section className="chart">
        <p className="empty-note">We need a live price for both options to draw this.</p>
      </section>
    );
  }

  // Dollars, on the amount the user actually asked about.
  const money = (bp: number) => {
    const d = (bp / 10_000) * quote.intent.notionalUsd;
    const abs = Math.abs(d);
    return `${d < 0 ? "-" : ""}$${abs.toLocaleString(undefined, {
      minimumFractionDigits: abs < 100 ? 2 : 0, maximumFractionDigits: abs < 100 ? 2 : 0,
    })}`;
  };

  const all = [curve.rtFixed, ...curve.perpAt.map((p) => p.high), ...curve.perpAt.map((p) => p.low)];
  const max = Math.max(...all) * 1.1;
  const min = Math.min(0, ...all);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (d: number) => PAD.left + (d / MAX_DAYS) * innerW;
  const y = (v: number) => PAD.top + innerH - ((v - min) / (max - min)) * innerH;

  const band = [
    ...curve.perpAt.map((p) => `${x(p.d)},${y(p.high)}`),
    ...[...curve.perpAt].reverse().map((p) => `${x(p.d)},${y(p.low)}`),
  ].join(" ");

  return (
    <section className="chart">
      <h2>What it costs you the longer you hold</h2>
      <p className="sub">
        The tokenized stock charges you once, when you buy and sell, so its line is flat.
        The futures contract keeps charging a holding fee, so its line climbs. The shaded
        area is how wrong that holding fee could turn out to be.
      </p>

      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="What it costs you the longer you hold">
        {Array.from({ length: 5 }, (_, i) => {
          const v = min + ((max - min) / 4) * i;
          return (
            <g key={i}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="grid" />
              <text x={PAD.left - 10} y={y(v) + 4} className="axis" textAnchor="end">{money(v)}</text>
            </g>
          );
        })}

        <polygon points={band} className="fundband" />
        <polyline className="line perp" points={curve.perpAt.map((p) => `${x(p.d)},${y(p.mid)}`).join(" ")} />
        <line className="line rtoken" x1={x(0)} x2={x(MAX_DAYS)} y1={y(curve.rtFixed)} y2={y(curve.rtFixed)} />

        {curve.cross !== null && (
          <g>
            <line x1={x(curve.cross)} x2={x(curve.cross)} y1={PAD.top} y2={PAD.top + innerH} className="crossline" />
            <text x={x(curve.cross)} y={PAD.top - 8} className="crosslabel" textAnchor="middle">
              they cross at {curve.cross.toFixed(0)} days
            </text>
          </g>
        )}

        <line
          x1={x(quote.intent.horizonDays)} x2={x(quote.intent.horizonDays)}
          y1={PAD.top} y2={PAD.top + innerH} className="nowline"
        />
        <text x={x(quote.intent.horizonDays)} y={H - 26} className="nowlabel" textAnchor="middle">
          you said {quote.intent.horizonDays} days
        </text>

        {[0, 30, 60, 90, 120].map((d) => (
          <text key={d} x={x(d)} y={H - 8} className="xlabel" textAnchor="middle">{d}d</text>
        ))}
      </svg>

      <div className="legend">
        <span className="key rtoken"><i /> Tokenized stock</span>
        <span className="key perp"><i /> Futures contract</span>
      </div>

      <p className="sub">
        {curve.cross === null
          ? "These never cross within four months, so how long you hold does not change which one to use."
          : `Hold for less than ${curve.cross.toFixed(0)} days and the futures contract is cheaper. ` +
            `Hold longer and the tokenized stock wins, because the holding fee keeps adding up. ` +
            `You said ${quote.intent.horizonDays} days, which is on the ` +
            `${quote.intent.horizonDays < curve.cross ? "futures" : "tokenized stock"} side of that line.`}
      </p>
    </section>
  );
}
