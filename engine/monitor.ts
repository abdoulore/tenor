/**
 * Monitor: should you move a position you already hold.
 *
 * This is a different question from "which should I open", and answering it with the opening
 * comparison would be wrong. Someone already holding has paid their entry cost, and it is
 * gone whatever they do next. What matters from here is only what is still to come.
 *
 *   staying   = funding on the route you hold, for the days remaining, plus the exit you
 *               were always going to pay
 *   switching = that same exit, plus a fresh entry and exit on the other route, plus its
 *               funding for the days remaining
 *
 * The exit you were always going to pay appears on both sides and cancels. So:
 *
 *   saving from switching = funding you avoid − funding you take on − a full round trip
 *
 * A switch is only worth flagging when that is positive by a real margin. Telling someone to
 * pay a round trip to save less than the round trip is how a tool loses trust in one click.
 */

import { execution, isEmpty } from "./book.ts";
import { DEFAULT_FEES, roundTripFeeBp, type FeeSchedule } from "./fees.ts";
import { projectFunding, type Settlement } from "./funding.ts";
import { ROUTE_LABELS } from "./eligibility.ts";
import type { Book, Direction, Range, RouteId } from "./types.ts";

export interface Position {
  id: string;
  ticker: string;
  /** The route actually held. */
  route: RouteId;
  notionalUsd: number;
  direction: Direction;
  /** ISO date the position was opened. */
  openedAt: string;
  /** Total intended holding period in days, from opening. */
  horizonDays: number;
  /** What the engine said when it was opened, for the record. */
  openedOnAdviceOf?: RouteId;
}

export type SwitchVerdict =
  | "stay"
  /** Moving saves more than it costs, by a margin worth acting on. */
  | "switch"
  /** The alternative is cheaper, but not by enough to cover moving. */
  | "not_worth_it"
  /** The position cannot be exited right now at any price. */
  | "stuck"
  /** Nothing to compare against, so no advice is offered. */
  | "unknown";

export interface SwitchAnalysis {
  position: Position;
  daysRemaining: number;
  verdict: SwitchVerdict;
  /** Plain language, always present. */
  message: string;

  /** Funding still to pay on the route held, over the days remaining. */
  stayFundingBp: Range | null;
  /** Funding on the alternative over the same days. */
  switchFundingBp: Range | null;
  /** Fee plus execution to get into and out of the alternative, paid once, now. */
  switchCostBp: number | null;
  /** Funding avoided minus funding taken on minus the round trip. Positive means move. */
  netSavingBp: Range | null;
  /** Days at which the funding saved would cover the cost of moving. Infinity if never. */
  breakevenDays: number;

  alternative: RouteId | null;
  /** True when the held route currently has no market, so exiting is not possible. */
  cannotExit: boolean;
}

export interface MonitorInputs {
  books: Partial<Record<RouteId, Book>>;
  funding?: Settlement[];
  fundingIntervalHours?: number;
  fees?: FeeSchedule;
  now?: number;
  /**
   * How much a move must save before it is worth recommending, as a share of the cost of
   * moving. 0.25 means the saving has to beat the round trip by a quarter of it again,
   * which keeps marginal churn off the screen.
   */
  marginOfSafety?: number;
}

const DAY_MS = 86_400_000;
const round = (x: number, dp = 4) => Math.round(x * 10 ** dp) / 10 ** dp;

export function daysRemaining(p: Position, now = Date.now()): number {
  const elapsed = (now - Date.parse(p.openedAt)) / DAY_MS;
  return Math.max(0, round(p.horizonDays - elapsed, 2));
}

/** The other live route. Stock+ cannot be priced, so it is never proposed as a destination. */
function alternativeTo(route: RouteId): RouteId | null {
  if (route === "rtoken") return "perp";
  if (route === "perp") return "rtoken";
  return null;
}

export function analysePosition(p: Position, inputs: MonitorInputs): SwitchAnalysis {
  const fees = inputs.fees ?? DEFAULT_FEES;
  const now = inputs.now ?? Date.now();
  const margin = inputs.marginOfSafety ?? 0.25;
  const left = daysRemaining(p, now);
  const alt = alternativeTo(p.route);

  const base: SwitchAnalysis = {
    position: p,
    daysRemaining: left,
    verdict: "unknown",
    message: "",
    stayFundingBp: null,
    switchFundingBp: null,
    switchCostBp: null,
    netSavingBp: null,
    breakevenDays: Infinity,
    alternative: alt,
    cannotExit: false,
  };

  const held = inputs.books[p.route];
  const other = alt ? inputs.books[alt] : undefined;

  // Being unable to get out is the most important thing this can tell anyone, so it is
  // checked before any arithmetic about whether leaving would be a good idea.
  if (!held || isEmpty(held)) {
    return {
      ...base,
      verdict: "stuck",
      cannotExit: true,
      message:
        `Nobody is quoting a price for your ${ROUTE_LABELS[p.route].toLowerCase()} right now, ` +
        `so you could not sell it even if you wanted to. Nothing to do until a market returns.`,
    };
  }

  if (!alt || !other || isEmpty(other)) {
    return {
      ...base,
      verdict: "stay",
      message: `There is no other tradeable way to hold ${p.ticker} right now, so stay where you are.`,
    };
  }

  const exec = execution(other, p.notionalUsd, p.direction);
  if (!exec || exec.roundTripBp === null) {
    return {
      ...base,
      verdict: "stay",
      message:
        `The ${ROUTE_LABELS[alt].toLowerCase()} cannot absorb $${p.notionalUsd.toLocaleString()} ` +
        `right now, so moving is not an option even if it were cheaper.`,
    };
  }

  // Funding runs on the perp only. Whichever side the position is on, one of these is zero.
  const zero: Range = { low: 0, mid: 0, high: 0 };
  const projected = (route: RouteId): Range => {
    if (route !== "perp") return zero;
    return projectFunding(inputs.funding ?? [], left, p.direction, {
      atMs: now,
      intervalHours: inputs.fundingIntervalHours ?? 8,
    }).bp;
  };

  const stayFunding = projected(p.route);
  const switchFunding = projected(alt);
  const switchCost = round(roundTripFeeBp(alt, fees) + exec.roundTripBp);

  const net: Range = {
    low: round(stayFunding.low - switchFunding.high - switchCost),
    mid: round(stayFunding.mid - switchFunding.mid - switchCost),
    high: round(stayFunding.high - switchFunding.low - switchCost),
  };

  /*
   * How long the funding difference takes to cover the cost of moving. Uses the daily rate
   * implied by the remaining horizon, so it answers "from today" rather than from opening.
   */
  const dailyEdge = left > 0 ? (stayFunding.mid - switchFunding.mid) / left : 0;
  const breakevenDays = dailyEdge > 0 ? round(switchCost / dailyEdge, 1) : Infinity;

  const threshold = switchCost * margin;
  const money = (bp: number) => `$${Math.abs((bp / 10_000) * p.notionalUsd).toFixed(2)}`;

  if (net.mid > threshold) {
    return {
      ...base,
      verdict: "switch",
      stayFundingBp: stayFunding, switchFundingBp: switchFunding,
      switchCostBp: switchCost, netSavingBp: net, breakevenDays,
      message:
        `Moving to the ${ROUTE_LABELS[alt].toLowerCase()} costs ${money(switchCost)} today and ` +
        `should save about ${money(net.mid)} over your remaining ${left.toFixed(0)} days. ` +
        `It pays for itself in ${breakevenDays === Infinity ? "never" : `${breakevenDays} days`}.`,
    };
  }

  if (net.mid > 0) {
    return {
      ...base,
      verdict: "not_worth_it",
      stayFundingBp: stayFunding, switchFundingBp: switchFunding,
      switchCostBp: switchCost, netSavingBp: net, breakevenDays,
      message:
        `The ${ROUTE_LABELS[alt].toLowerCase()} is slightly cheaper from here, but moving costs ` +
        `${money(switchCost)} and would only save ${money(net.mid)}. Not worth the trade.`,
    };
  }

  return {
    ...base,
    verdict: "stay",
    stayFundingBp: stayFunding, switchFundingBp: switchFunding,
    switchCostBp: switchCost, netSavingBp: net, breakevenDays,
    message:
      `Stay put. Moving to the ${ROUTE_LABELS[alt].toLowerCase()} would cost ${money(switchCost)} ` +
      `and leave you ${money(net.mid)} worse off over the days you have left.`,
  };
}
