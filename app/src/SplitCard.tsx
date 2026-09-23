/**
 * Splitting a large order across the two wrappers.
 *
 * Shown only when splitting genuinely saves money, or when it is the only way to fill the
 * order at all. For ordinary sizes one wrapper is simply cheaper, and a card suggesting a split
 * worth pennies would be noise.
 *
 * The curve is the argument: total cost against how much of the order goes through the
 * perpetual. All tokenized on the left, all perpetual on the right, the cheapest mix marked.
 */

import type { SplitPlan } from "../../engine/split.ts";

const W = 760;
const H = 200;
const PAD = { top: 18, right: 20, bottom: 36, left: 76 };

const dollars = (x: number) =>
  `$${x.toLocaleString(undefined, { minimumFractionDigits: x < 100 ? 2 : 0, maximumFractionDigits: x < 100 ? 2 : 0 })}`;

export function SplitCard({ plan }: { plan: SplitPlan }) {
  if (!plan.applicable) return null;

  // Only show the "no benefit" line where someone might reasonably have expected one.
  if (!plan.worthIt) {
    if (plan.notionalUsd < 10_000) return null;
    return (
      <p className="split-none">
        Splitting this order across both would not help at ${plan.notionalUsd.toLocaleString()}: one
        of the two can take it all more cheaply.
      </p>
    );
  }

  const pts = plan.curve.filter((p) => p.totalUsd !== null) as { perpShare: number; totalUsd: number }[];
  const lo = Math.min(...pts.map((p) => p.totalUsd));
  const hi = Math.max(...pts.map((p) => p.totalUsd));
  const pad = (hi - lo) * 0.12 || hi * 0.05 || 1;
  const yMin = Math.max(0, lo - pad);
  const yMax = hi + pad;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (share: number) => PAD.left + share * innerW;
  const y = (v: number) => PAD.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  // Break the line where a split cannot be filled, so an impossible mix is never drawn as a price.
  const segs: { perpShare: number; totalUsd: number }[][] = [];
  let cur: { perpShare: number; totalUsd: number }[] = [];
  for (const p of plan.curve) {
    if (p.totalUsd === null) { if (cur.length) segs.push(cur); cur = []; }
    else cur.push(p as { perpShare: number; totalUsd: number });
  }
  if (cur.length) segs.push(cur);

  const perpPct = Math.round(plan.perpShare * 100);
  const single = plan.bestSingle;

  return (
    <section className="split">
      <div className="split-head">
        <span className="badge">cheaper still</span>
        <h3>Split it across both</h3>
      </div>

      <p className="split-main">
        Put <strong>{dollars(plan.perpUsd)}</strong> through the perpetual and{" "}
        <strong>{dollars(plan.tokenUsd)}</strong> through the tokenized stock.
      </p>
      <p className="split-save">
        {single
          ? <>That costs about <strong>{dollars(plan.totalUsd)}</strong> in total, and saves{" "}
              <strong>{dollars(plan.savingUsd)}</strong> against putting it all in{" "}
              {single.route === "perp" ? "the perpetual" : "the tokenized stock"}.</>
          : <>Neither can take the whole order on its own. Split this way it fills, for about{" "}
              <strong>{dollars(plan.totalUsd)}</strong> in total.</>}
        {plan.totalRangeUsd.high - plan.totalRangeUsd.low > 0.01 && (
          <span className="split-range">
            {" "}Anywhere from {dollars(plan.totalRangeUsd.low)} to {dollars(plan.totalRangeUsd.high)}, because
            funding on the perpetual part is a forecast.
          </span>
        )}
      </p>

      <div className="split-bar" aria-label={`${perpPct}% perpetual, ${100 - perpPct}% tokenized stock`}>
        <span className="seg perp" style={{ width: `${perpPct}%` }}>{perpPct >= 12 ? `${perpPct}% perpetual` : ""}</span>
        <span className="seg rtoken" style={{ width: `${100 - perpPct}%` }}>{100 - perpPct >= 12 ? `${100 - perpPct}% tokenized` : ""}</span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Total cost against how much of the order goes through the perpetual">
        {[yMin, (yMin + yMax) / 2, yMax].map((v, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="grid" />
            <text x={PAD.left - 10} y={y(v) + 4} className="axis" textAnchor="end">{dollars(v)}</text>
          </g>
        ))}
        {segs.map((seg, k) => (
          <polyline key={k} className="split-line" points={seg.map((p) => `${x(p.perpShare)},${y(p.totalUsd)}`).join(" ")} />
        ))}
        <line x1={x(plan.perpShare)} x2={x(plan.perpShare)} y1={PAD.top} y2={PAD.top + innerH} className="crossline" />
        <circle cx={x(plan.perpShare)} cy={y(plan.totalUsd)} r={6} className="split-dot" />
        <text
          x={x(plan.perpShare)}
          y={PAD.top - 4}
          className="crosslabel"
          textAnchor={plan.perpShare < 0.15 ? "start" : plan.perpShare > 0.85 ? "end" : "middle"}
        >
          cheapest mix
        </text>
        <text x={PAD.left} y={H - 10} className="xlabel" textAnchor="start">all tokenized</text>
        <text x={W - PAD.right} y={H - 10} className="xlabel" textAnchor="end">all perpetual</text>
      </svg>

      <p className="note">
        Two positions to manage instead of one. Only the perpetual part pays funding. Each part is
        priced from Bitget's live quote and order book.
      </p>
    </section>
  );
}
