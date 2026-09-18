/**
 * The parsed intent, as controls you can change.
 *
 * These used to be read-only chips describing what the sentence was understood to mean.
 * That had two problems. Correcting a misreading meant rewriting your sentence and hoping,
 * and the chips described the last parse while the follow-up buttons changed the intent
 * underneath them, so the two could disagree on screen.
 *
 * Now the controls are the intent. The sentence only seeds them. Anything you change here
 * is what gets priced, and each field says whether it came from your words, a default, or
 * your own edit.
 */

import type { Constraints, Direction, Intent } from "../../engine/types.ts";

export type FieldOrigin = "read" | "assumed" | "edited";

const AMOUNTS = [500, 1_000, 2_000, 5_000, 10_000, 25_000, 50_000, 100_000];

const HOLD_PERIODS: { label: string; days: number }[] = [
  { label: "A day", days: 1 },
  { label: "A week", days: 7 },
  { label: "Two weeks", days: 14 },
  { label: "A month", days: 30 },
  { label: "Three months", days: 90 },
  { label: "A year", days: 365 },
];

const LEVERAGE = [1, 2, 3, 5, 10, 20];

function Origin({ origin }: { origin: FieldOrigin }) {
  const text = origin === "read" ? "from your words" : origin === "edited" ? "you changed this" : "assumed";
  return <span className={`origin ${origin}`}>{text}</span>;
}

export function IntentControls({
  intent,
  origins,
  tickers,
  onChange,
  busy,
}: {
  intent: Intent;
  origins: Record<string, FieldOrigin>;
  tickers: string[];
  onChange: (patch: Partial<Intent> & { constraints?: Partial<Constraints> }) => void;
  busy: boolean;
}) {
  const c = intent.constraints;
  const setC = (patch: Partial<Constraints>) => onChange({ constraints: patch });

  // An amount that is not one of the presets still has to appear in the list, or the select
  // would silently snap the user's number to something they did not choose.
  const amounts = AMOUNTS.includes(intent.notionalUsd)
    ? AMOUNTS
    : [...AMOUNTS, intent.notionalUsd].sort((a, b) => a - b);
  const periods = HOLD_PERIODS.some((p) => p.days === intent.horizonDays)
    ? HOLD_PERIODS
    : [...HOLD_PERIODS, { label: `${intent.horizonDays} days`, days: intent.horizonDays }]
        .sort((a, b) => a.days - b.days);
  const levels = LEVERAGE.includes(c.leverage) ? LEVERAGE : [...LEVERAGE, c.leverage].sort((a, b) => a - b);

  return (
    <section className="controls" aria-label="What you are pricing">
      <div className="control">
        <label htmlFor="f-ticker">Company</label>
        <input
          id="f-ticker"
          list="ticker-list"
          value={intent.ticker}
          disabled={busy}
          onChange={(e) => onChange({ ticker: e.target.value.toUpperCase().trim() })}
          placeholder="NVDA"
          autoComplete="off"
          spellCheck={false}
        />
        <datalist id="ticker-list">
          {tickers.map((t) => <option key={t} value={t} />)}
        </datalist>
        <Origin origin={origins.ticker ?? "assumed"} />
      </div>

      <div className="control">
        <label htmlFor="f-amount">How much</label>
        <select
          id="f-amount"
          value={intent.notionalUsd}
          disabled={busy}
          onChange={(e) => onChange({ notionalUsd: Number(e.target.value) })}
        >
          {amounts.map((a) => (
            <option key={a} value={a}>${a.toLocaleString()}</option>
          ))}
        </select>
        <Origin origin={origins.size ?? "assumed"} />
      </div>

      <div className="control">
        <label htmlFor="f-direction">You think it will</label>
        <select
          id="f-direction"
          value={intent.direction}
          disabled={busy}
          onChange={(e) => {
            const direction = e.target.value as Direction;
            onChange({ direction, constraints: { needsShort: direction === "short" } });
          }}
        >
          <option value="long">Go up</option>
          <option value="short">Go down</option>
        </select>
        <Origin origin={origins.direction ?? "assumed"} />
      </div>

      <div className="control">
        <label htmlFor="f-hold">Hold it for</label>
        <select
          id="f-hold"
          value={intent.horizonDays}
          disabled={busy}
          onChange={(e) => onChange({ horizonDays: Number(e.target.value) })}
        >
          {periods.map((p) => (
            <option key={p.days} value={p.days}>{p.label}</option>
          ))}
        </select>
        <Origin origin={origins.horizon ?? "assumed"} />
      </div>

      <div className="control">
        <label htmlFor="f-leverage">Borrow to boost it</label>
        <select
          id="f-leverage"
          value={c.leverage}
          disabled={busy}
          onChange={(e) => setC({ leverage: Number(e.target.value) })}
        >
          {levels.map((l) => (
            <option key={l} value={l}>{l === 1 ? "No, just my own money" : `Yes, ${l} times`}</option>
          ))}
        </select>
        <Origin origin={origins.leverage ?? "assumed"} />
      </div>

      <div className="control wants">
        <label>It also has to</label>
        <div className="checks">
          <label className="check">
            <input
              type="checkbox" checked={c.needsOffHoursExit} disabled={busy}
              onChange={(e) => setC({ needsOffHoursExit: e.target.checked })}
            />
            let me sell outside US market hours
          </label>
          <label className="check">
            <input
              type="checkbox" checked={c.wantsDividends} disabled={busy}
              onChange={(e) => setC({ wantsDividends: e.target.checked })}
            />
            pay dividends
          </label>
          <label className="check">
            <input
              type="checkbox" checked={c.wantsVoting} disabled={busy}
              onChange={(e) => setC({ wantsVoting: e.target.checked })}
            />
            come with a shareholder vote
          </label>
          <label className="check">
            <input
              type="checkbox" checked={c.usesAsCollateral} disabled={busy}
              onChange={(e) => setC({ usesAsCollateral: e.target.checked })}
            />
            work as collateral for borrowing
          </label>
        </div>
      </div>
    </section>
  );
}
