/** Type surface for universe.mjs, so the TypeScript engine and the Vite app can import it. */

export declare const BASE: string;
export declare const CANARY_LIQUID: string[];
export declare const CONTROL_THIN: string[];
export declare const MIN_PERP_QUOTE_VOL_24H: number;
export declare const MIN_SPOT_QUOTE_VOL_24H: number;

export declare function rowsOf(data: unknown): Record<string, unknown>[];
export declare function extractRTokens(rows: Record<string, unknown>[]): {
  rTokens: Map<string, string>;
  flagPresent: boolean;
};
export declare function cryptoSpotBases(rows: Record<string, unknown>[], flagPresent: boolean): Set<string>;
export declare function perpIsStock(r: Record<string, unknown>): boolean | null;
export declare function extractVolume(r: Record<string, unknown>): number | null;
export declare function extractPlatformVolume(r: Record<string, unknown>): number | null;

export interface UniversePair {
  ticker: string;
  spotSymbol: string;
  perpSymbol: string;
  symbolType: string;
  isRwa: string;
  perpVolume24h: number | null;
  spotVolume24h: number | null;
  spotPlatformVolume24h: number | null;
  thin: boolean;
}

export declare function buildUniverse(
  spotRows: Record<string, unknown>[],
  perpRows: Record<string, unknown>[],
  volumes: { spot: Map<string, number>; perp: Map<string, number>; spotPlatform: Map<string, number> },
): {
  pairs: UniversePair[];
  excluded: { ticker: string; reason: string }[];
  rTokenCount: number;
  perpCount: number;
  realityFlagOnSpot: boolean;
  perpFilter: "marker" | "collision";
};
