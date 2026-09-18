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

import type { Constraints, Direction } from "../../engine/types.ts";

/**
 * A part-filled intent. Nothing is chosen for the user, so every field can be unset and the
 * controls open on a placeholder rather than on a guess.
 */
export interface Draft {
  ticker: string;
  notionalUsd: number | null;
  direction: Direction | null;
  horizonDays: number | null;
  constraints: Constraints;
}

export const EMPTY_DRAFT: Draft = {
  ticker: "",
  notionalUsd: null,
  direction: null,
  horizonDays: null,
  constraints: {
    leverage: 1,
    needsShort: false,
    wantsDividends: false,
    wantsVoting: false,
    usesAsCollateral: false,
    needsOffHoursExit: false,
  },
};

/** The four things we cannot price without. */
export const isComplete = (d: Draft): boolean =>
  Boolean(d.ticker && d.notionalUsd && d.direction && d.horizonDays);

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

export interface TickerGroups {
  /** Sampled, and the tokenized side actually quotes a price. */
  tradeable: string[];
  /** Sampled continuously and never quoted once. Listed, but there is no market. */
  dead: string[];
  /** Has both legs on Bitget but falls below the volume floor, so we have no history. */
  untracked: string[];
}

export function IntentControls({
  draft,
  groups,
  onChange,
  busy,
}: {
  draft: Draft;
  groups: TickerGroups;
  onChange: (patch: Partial<Draft> & { constraints?: Partial<Constraints> }) => void;
  busy: boolean;
}) {
  const isDead = groups.dead.includes(draft.ticker);
  const isUntracked = groups.untracked.includes(draft.ticker);
  /*
   * A ticker typed into the sentence box can arrive before the listing has loaded, and a
   * select whose value matches no option renders blank. Carry it as its own option so the
   * field always shows what is actually being priced.
   */
  const known = isDead || isUntracked || groups.tradeable.includes(draft.ticker);
  const c = draft.constraints;
  const setC = (patch: Partial<Constraints>) => onChange({ constraints: patch });

  // An amount that is not one of the presets still has to appear in the list, or the select
  // would silently snap the user's number to something they did not choose.
  const amounts = draft.notionalUsd && !AMOUNTS.includes(draft.notionalUsd)
    ? [...AMOUNTS, draft.notionalUsd].sort((a, b) => a - b)
    : AMOUNTS;
  const periods = draft.horizonDays && !HOLD_PERIODS.some((p) => p.days === draft.horizonDays)
    ? [...HOLD_PERIODS, { label: `${draft.horizonDays} days`, days: draft.horizonDays }]
        .sort((a, b) => a.days - b.days)
    : HOLD_PERIODS;
  const levels = LEVERAGE.includes(c.leverage) ? LEVERAGE : [...LEVERAGE, c.leverage].sort((a, b) => a - b);

  return (
    <section className="controls" aria-label="What you are pricing">
      {/*
        * Every company Bitget lists is offered, grouped by whether it can actually be traded.
        * Hiding the dead ones would hide the strongest thing we found: Bitget lists a
        * tokenized Netflix, McDonald's and Exxon, and not one of them has ever had a buyer or
        * seller while we have been watching. Someone who picks one should meet that as an
        * answer, not as a broken page.
        */}
      <div className="control">
        <label htmlFor="f-ticker">Company</label>
        <select
          id="f-ticker"
          value={draft.ticker}
          disabled={busy}
          onChange={(e) => onChange({ ticker: e.target.value })}
        >
          <option value="" disabled>Choose a company</option>
          {!known && draft.ticker && <option value={draft.ticker}>{draft.ticker}</option>}
          <optgroup label={`Can be traded (${groups.tradeable.length})`}>
            {groups.tradeable.map((t) => <option key={t} value={t}>{t}</option>)}
          </optgroup>
          <optgroup label={`Listed, but nobody trades them (${groups.dead.length})`}>
            {groups.dead.map((t) => <option key={t} value={t}>{t} — no market</option>)}
          </optgroup>
          <optgroup label={`Too small for us to have watched (${groups.untracked.length})`}>
            {groups.untracked.map((t) => <option key={t} value={t}>{t} — not tracked</option>)}
          </optgroup>
        </select>
      </div>

      <div className="control">
        <label htmlFor="f-amount">How much</label>
        <select
          id="f-amount"
          value={draft.notionalUsd ?? ""}
          disabled={busy}
          onChange={(e) => onChange({ notionalUsd: Number(e.target.value) })}
        >
          <option value="" disabled>Choose an amount</option>
          {amounts.map((a) => (
            <option key={a} value={a}>${a.toLocaleString()}</option>
          ))}
        </select>
      </div>

      <div className="control">
        <label htmlFor="f-direction">You think it will</label>
        <select
          id="f-direction"
          value={draft.direction ?? ""}
          disabled={busy}
          onChange={(e) => {
            const direction = e.target.value as Direction;
            onChange({ direction, constraints: { needsShort: direction === "short" } });
          }}
        >
          <option value="" disabled>Go up or down</option>
          <option value="long">Go up</option>
          <option value="short">Go down</option>
        </select>
      </div>

      <div className="control">
        <label htmlFor="f-hold">Hold it for</label>
        <select
          id="f-hold"
          value={draft.horizonDays ?? ""}
          disabled={busy}
          onChange={(e) => onChange({ horizonDays: Number(e.target.value) })}
        >
          <option value="" disabled>Choose how long</option>
          {periods.map((p) => (
            <option key={p.days} value={p.days}>{p.label}</option>
          ))}
        </select>
      </div>

      {/*
        * Leverage, said in dollars.
        *
        * "Borrow to boost it: yes, 2 times" does not say what is doubled, and a multiplier
        * on its own is meaningless without the amount beside it. Spelling out the exposure
        * it buys makes the choice concrete, and the note below makes its consequence visible
        * before pricing rather than as a rejection afterwards.
        */}
      <div className="control">
        <label htmlFor="f-leverage">Borrow to trade bigger</label>
        <select
          id="f-leverage"
          value={c.leverage}
          disabled={busy}
          onChange={(e) => setC({ leverage: Number(e.target.value) })}
        >
          {levels.map((l) => (
            <option key={l} value={l}>
              {l === 1
                ? "No, just my own money"
                : draft.notionalUsd
                  ? `Yes, control $${(draft.notionalUsd * l).toLocaleString()} with my $${draft.notionalUsd.toLocaleString()}`
                  : `Yes, ${l} times my money`}
            </option>
          ))}
        </select>
        {c.leverage > 1 && (
          <p className="fieldnote">
            Borrowing {c.leverage} times means a {(100 / c.leverage).toFixed(0)}% move against you
            wipes out your stake. Only the futures contract can do this; the tokenized stock is
            bought outright with your own money.
          </p>
        )}
      </div>

      {(isDead || isUntracked) && (
        <div className="control picker-note" role="status">
          {isDead ? (
            <p className="dead-note">
              Bitget lists a tokenized {draft.ticker}, but in every check we have made since
              Tuesday nobody has offered to buy or sell it. You can still price it. The answer
              will be that only the futures contract is available.
            </p>
          ) : (
            <p className="untracked-note">
              {draft.ticker} trades too little for us to have been watching it, so we can price
              it live but cannot tell you anything about the best hour to trade it.
            </p>
          )}
        </div>
      )}

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
