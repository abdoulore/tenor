/**
 * Prediction log.
 *
 * Every recommendation the engine makes is written here the moment it is made. These lines
 * cannot be backfilled: a prediction logged after the outcome is known is not a prediction,
 * and Saturday's receipts are exactly these lines compared against what actually happened.
 *
 * Append only, one JSON object per line, no consumer required. It logs whether or not
 * anything is reading it.
 */

import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Quote, RouteId, Session } from "./types.ts";

export const PREDICTION_SCHEMA = 1;

export interface PredictionRecord {
  v: number;
  /** Stable id so an outcome can be matched back to the prediction that made it. */
  id: string;
  at: string;
  ticker: string;
  session: Session;
  notionalUsd: number;
  direction: "long" | "short";
  horizonDays: number;

  /** The recommendation itself. Null means nothing was tradeable, which is still a call. */
  route: RouteId | null;
  predictedBp: number | null;
  predictedLowBp: number | null;
  predictedHighBp: number | null;

  /**
   * Which gate produced the answer. This is the part worth auditing later: a call decided by
   * an empty book is a different kind of claim from one decided by a 2bp cost difference.
   */
  decidedBy: "no_route" | "only_route" | "availability" | "size" | "execution" | "horizon";
  /** Plain language, the same sentence the user was shown. */
  rationale: string;

  /** Every route's status at the time, so a wrong call can be diagnosed rather than guessed at. */
  routes: { route: RouteId; status: string; totalBp: number | null; executionBp: number | null; source?: "book" | "quote" | null }[];
  /** Data age at the time of the call, per route, where known. */
  stalenessMs: Record<string, number> | null;
  source: string;
}

/**
 * Why did the engine land where it did.
 *
 * Ordered most decisive first. If the runner up had no book at all, availability decided and
 * nothing else got a say. Only once two routes are both tradeable does cost decide, and only
 * once execution is inside the fee gap does the horizon decide.
 */
export function decidedBy(q: Quote): PredictionRecord["decidedBy"] {
  const ranked = q.routes.filter((r) => r.rank !== null).sort((a, b) => a.rank! - b.rank!);
  if (!ranked.length) return "no_route";

  const contenders = q.routes.filter((r) => r.route !== "stockplus");
  const blocked = contenders.filter((r) => r.status === "no_book" || r.status === "cannot_fill");
  if (ranked.length === 1) {
    if (blocked.some((r) => r.status === "no_book")) return "availability";
    if (blocked.some((r) => r.status === "cannot_fill")) return "size";
    return "only_route";
  }
  return q.horizonDecides ? "horizon" : "execution";
}

export function rationaleFor(q: Quote): string {
  const best = q.routes.find((r) => r.rank === 1);
  if (!best) return "No route could trade this intent.";
  const runnerUp = q.routes.find((r) => r.rank === 2);
  const blocked = q.routes.find((r) => r.route !== "stockplus" && r.status === "no_book");

  if (!runnerUp) {
    if (blocked) return `${best.label} is the only route, because ${blocked.label.toLowerCase()} has no order book.`;
    return `${best.label} is the only route that can trade this.`;
  }
  const diff = runnerUp.totalBp!.mid - best.totalBp!.mid;
  const basis = q.horizonDecides ? "and execution is close enough that the holding period decides" : "on execution cost";
  return `${best.label} by ${diff.toFixed(2)}bp ${basis}.`;
}

export function toRecord(q: Quote, source: string): PredictionRecord {
  const best = q.routes.find((r) => r.rank === 1) ?? null;
  return {
    v: PREDICTION_SCHEMA,
    id: `${q.intent.ticker}-${Date.parse(q.at)}-${q.intent.notionalUsd}-${q.intent.horizonDays}`,
    at: q.at,
    ticker: q.intent.ticker,
    session: q.session,
    notionalUsd: q.intent.notionalUsd,
    direction: q.intent.direction,
    horizonDays: q.intent.horizonDays,
    route: best?.route ?? null,
    predictedBp: best?.totalBp?.mid ?? null,
    predictedLowBp: best?.totalBp?.low ?? null,
    predictedHighBp: best?.totalBp?.high ?? null,
    decidedBy: decidedBy(q),
    rationale: rationaleFor(q),
    routes: q.routes.map((r) => ({
      route: r.route,
      status: r.status,
      totalBp: r.totalBp?.mid ?? null,
      executionBp: r.executionBp,
      source: r.source ?? null,
    })),
    stalenessMs: (() => {
      const out: Record<string, number> = {};
      for (const r of q.routes) if (r.stalenessMs !== null) out[r.route] = r.stalenessMs;
      return Object.keys(out).length ? out : null;
    })(),
    source,
  };
}

export function predictionFile(dir: string, at = new Date()): string {
  return join(dir, `predictions-${at.toISOString().slice(0, 10)}.ndjson`);
}

/**
 * Append one prediction. Never throws: a logging failure must not take down a quote, but it
 * is reported so a silently empty log cannot be mistaken for a quiet day.
 */
export async function logPrediction(
  q: Quote,
  opts: { dir: string; source: string },
): Promise<{ ok: boolean; file: string; error?: string }> {
  const file = predictionFile(opts.dir, new Date(q.at));
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(toRecord(q, opts.source)) + "\n", "utf8");
    return { ok: true, file };
  } catch (e) {
    return { ok: false, file, error: String((e as Error)?.message ?? e) };
  }
}

export async function readPredictions(dir: string): Promise<PredictionRecord[]> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.startsWith("predictions-") && f.endsWith(".ndjson")).sort();
  } catch {
    return [];
  }
  const out: PredictionRecord[] = [];
  for (const f of files) {
    const text = await readFile(join(dir, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as PredictionRecord); } catch { /* skip a torn line */ }
    }
  }
  return out;
}
