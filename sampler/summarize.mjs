#!/usr/bin/env node
/**
 * Read the collected samples and print what they say so far.
 *
 * The headline column is gapBp: the rToken round trip execution cost minus the perp round
 * trip execution cost, at a given size. The fee gap the flip test rested on is 8bp in the
 * perp's favour. If the median gapBp is large and positive, execution cost dwarfs the fee
 * gap and the flip test's conclusion understates how often the perp wins. If it is large
 * and negative, the rToken quotes better than the perp and the conclusion flips.
 *
 *   node sampler/summarize.mjs [--data DIR] [--size 2000|10000] [--session regular]
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const DATA_DIR = flag("--data", process.env.DATA_DIR ?? join(process.cwd(), "sampler", "data"));
const SIZE = flag("--size", "2000");
const SESSION = flag("--session", null);

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const fmt = (x, dp = 1) => (x === null || x === undefined ? "n/a" : x.toFixed(dp));

async function main() {
  const files = (await readdir(DATA_DIR)).filter((f) => f.startsWith("samples-") && f.endsWith(".ndjson")).sort();
  if (!files.length) {
    console.log(`no sample files in ${DATA_DIR}`);
    return;
  }

  const byTicker = new Map();
  const sessions = new Map();
  let cycles = new Set();
  let rows = 0;

  for (const f of files) {
    const text = await readFile(join(DATA_DIR, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (SESSION && r.session !== SESSION) continue;
      rows++;
      cycles.add(r.cycle);

      const s = sessions.get(r.session) ?? { n: 0, emptySpot: 0 };
      s.n++;
      if (r.spot?.empty) s.emptySpot++;
      sessions.set(r.session, s);

      const t = byTicker.get(r.ticker) ?? {
        ticker: r.ticker, control: r.control, n: 0, emptySpot: 0, emptyPerp: 0,
        spotSpread: [], perpSpread: [], gap: [], spotRt: [], perpRt: [], spotExhausted: 0,
      };
      t.n++;
      if (r.spot?.empty) t.emptySpot++;
      if (r.perp?.empty) t.emptyPerp++;
      if (r.spot?.spreadBp !== undefined && r.spot?.spreadBp !== null) t.spotSpread.push(r.spot.spreadBp);
      if (r.perp?.spreadBp !== undefined && r.perp?.spreadBp !== null) t.perpSpread.push(r.perp.spreadBp);
      const srt = r.spot?.fills?.[SIZE]?.roundTripBp;
      const prt = r.perp?.fills?.[SIZE]?.roundTripBp;
      if (typeof srt === "number") t.spotRt.push(srt);
      if (typeof prt === "number") t.perpRt.push(prt);
      if (r.spot?.fills?.[SIZE]?.exhausted) t.spotExhausted++;
      const g = r.gapBp?.[SIZE];
      if (typeof g === "number") t.gap.push(g);
      byTicker.set(r.ticker, t);
    }
  }

  console.log(`\nTENOR SPREAD SAMPLER: what the data says so far`);
  console.log(`  ${rows} records across ${cycles.size} cycles, ${files.length} file(s), size $${Number(SIZE).toLocaleString()}${SESSION ? `, session ${SESSION}` : ""}`);
  console.log(`  Fee gap the flip test rested on: 8.00bp in the perp's favour.\n`);

  console.log("BY SESSION");
  for (const [name, s] of [...sessions].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${name.padEnd(11)} ${String(s.n).padStart(6)} records, rToken book empty on ${fmt((s.emptySpot / s.n) * 100)}%`);
  }

  const list = [...byTicker.values()].sort((a, b) => (median(b.gap) ?? -1e9) - (median(a.gap) ?? -1e9));
  console.log(`\nPER TICKER, sorted by median execution gap at $${Number(SIZE).toLocaleString()}`);
  console.log("ticker  | ctl | samples | rTok empty | rTok spread | perp spread | rTok RT | perp RT |   gap");
  console.log("-".repeat(96));
  for (const t of list) {
    const gap = median(t.gap);
    console.log(
      [
        t.ticker.padEnd(7),
        (t.control ? "yes" : "no").padEnd(3),
        String(t.n).padStart(7),
        `${fmt((t.emptySpot / t.n) * 100)}%`.padStart(10),
        `${fmt(median(t.spotSpread), 2)}bp`.padStart(11),
        `${fmt(median(t.perpSpread), 2)}bp`.padStart(11),
        `${fmt(median(t.spotRt), 2)}`.padStart(7),
        `${fmt(median(t.perpRt), 2)}`.padStart(7),
        `${gap === null ? "n/a" : (gap > 0 ? "+" : "") + fmt(gap, 2) + "bp"}`.padStart(9),
      ].join(" | "),
    );
  }

  const gaps = list.map((t) => median(t.gap)).filter((x) => x !== null);
  const swamped = gaps.filter((g) => Math.abs(g) > 8).length;
  console.log(`\nACROSS ${gaps.length} TICKERS WITH A PRICED GAP`);
  console.log(`  median gap ${fmt(median(gaps), 2)}bp`);
  console.log(`  ${swamped} of ${gaps.length} have an execution gap larger than the entire 8bp fee gap`);
  console.log(`  ${gaps.filter((g) => g > 0).length} favour the perp, ${gaps.filter((g) => g < 0).length} favour the rToken\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
