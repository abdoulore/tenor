/** Type surface for depth.mjs, so the TypeScript engine and the Vite app can import it. */

export declare const FILL_SIZES_USD: number[];

export declare function levels(raw: unknown): [number, number][];

export declare function walk(
  side: [number, number][],
  notionalUsd: number,
): { vwap: number | null; filledUsd: number; exhausted: boolean };

export declare function bookNotional(side: [number, number][]): number;

export declare function quoteLevels(
  row: unknown,
): { asks: [number, number][]; bids: [number, number][]; ts: number | null };

export declare function legMetrics(
  rawAsks: unknown,
  rawBids: unknown,
): Record<string, unknown> & { ok: boolean; empty?: boolean; reason?: string };

export declare function sessionLabel(
  date?: Date,
): "regular" | "premarket" | "afterhours" | "overnight" | "weekend";
