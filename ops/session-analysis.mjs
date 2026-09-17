#!/usr/bin/env node
/**
 * Per ticker, which session is actually cheapest for the rToken.
 *
 * The aggregate finding was that rTokens cost about 47% more in pre-market than in US
 * hours. That is a median across tickers, so it describes the typical ticker, not any
 * particular one, and NVDA inverts it outright. This asks the question the demo actually
 * needs answered: for how many tickers, and which ones.
 *
 * Liquidity is measured from the books themselves rather than from a reported volume field,
 * because turnover24h on an rToken carries the underlying's global figure and is useless for
 * ranking Bitget depth. The measure here is the median of the rToken's own resting book.
 *
 *   node ops/session-analysis.mjs [--size 2000] [--min-gap 1]
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const DATA_DIR = arg("--data", join(process.cwd(), "sampler", "data"));
const SIZE = arg("--size", "2000");
/** Below this, a session difference is not worth calling a difference. */
const MIN_GAP_BP = Number(arg("--min-gap", "1"));
const MIN_SAMPLES = Number(arg("--min-samples", "10"));
const SESSIONS = ["premarket", "regular", "afterhours", "overnight"];

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(0) + "%" : "n/a");
const f = (x, dp = 1) => (x === null || x === undefined ? "n/a" : x.toFixed(dp));

async function main() {
  const files = (await readdir(DATA_DIR))
    .filter((x) => x.startsWith("samples-") && x.endsWith(".ndjson")).sort();

  /** ticker -> { session -> {rt:[], empty, n}, depth:[], control } */
  const acc = new Map();
  let rows = 0;

  for (const file of files) {
    const text = await readFile(join(DATA_DIR, file), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!SESSIONS.includes(r.session)) continue;
      rows++;

      if (!acc.has(r.ticker)) {
        acc.set(r.ticker, {
          ticker: r.ticker, control: !!r.control, depth: [], perpVol: r.perpVolume24h ?? null,
          s: Object.fromEntries(SESSIONS.map((x) => [x, { rt: [], empty: 0, n: 0 }])),
        });
      }
      const t = acc.get(r.ticker);
      const b = t.s[r.session];
      b.n++;
      if (r.spot?.empty) b.empty++;
      const v = r.spot?.fills?.[SIZE]?.roundTripBp;
      if (typeof v === "number") b.rt.push(v);
      // Resting book on the thinner side is the honest depth measure.
      if (typeof r.spot?.askBookUsd === "number" && typeof r.spot?.bidBookUsd === "number") {
        t.depth.push(Math.min(r.spot.askBookUsd, r.spot.bidBookUsd));
      }
    }
  }

  const tickers = [];
  const neverAnyBook = [];

  for (const t of acc.values()) {
    const per = {};
    let scored = 0;
    for (const s of SESSIONS) {
      const b = t.s[s];
      per[s] = b.rt.length >= MIN_SAMPLES ? median(b.rt) : null;
      if (per[s] !== null) scored++;
    }
    const depth = median(t.depth) ?? 0;

    // A ticker that never quoted anywhere is a different finding, not a cheap session.
    const anyBook = SESSIONS.some((s) => t.s[s].rt.length > 0);
    if (!anyBook) { neverAnyBook.push(t.ticker); continue; }
    if (scored < 2) continue;

    const vals = SESSIONS.filter((s) => per[s] !== null).map((s) => ({ s, v: per[s] }));
    vals.sort((a, b) => a.v - b.v);
    const best = vals[0];
    const worst = vals[vals.length - 1];
    const spread = worst.v - best.v;

    tickers.push({
      ticker: t.ticker, per, depth, perpVol: t.perpVol,
      best: best.s, bestBp: best.v, worst: worst.s, worstBp: worst.v, spread,
      // Flat means no session meaningfully beats another, which is its own answer.
      flat: spread < MIN_GAP_BP,
      regular: per.regular,
      invertsHeadline: per.regular !== null && best.s !== "regular" && spread >= MIN_GAP_BP,
    });
  }

  tickers.sort((a, b) => b.depth - a.depth);

  // Liquidity terciles by measured rToken book depth.
  const withDepth = tickers.filter((t) => t.depth > 0);
  const cut1 = Math.floor(withDepth.length / 3);
  const cut2 = Math.floor((withDepth.length * 2) / 3);
  withDepth.forEach((t, i) => { t.tier = i < cut1 ? "deep" : i < cut2 ? "mid" : "shallow"; });
  for (const t of tickers) if (!t.tier) t.tier = "shallow";

  // ---------------------------------------------------------------- report

  const line = "=".repeat(92);
  console.log(`\n${line}\nWHICH SESSION IS CHEAPEST FOR THE rTOKEN, PER TICKER\n${line}`);
  console.log(`  size $${Number(SIZE).toLocaleString()}, ${rows.toLocaleString()} samples, ${files.length} file(s)`);
  console.log(`  a session must have ${MIN_SAMPLES}+ samples to be scored`);
  console.log(`  a ticker counts as having a cheapest session only when the spread is ${MIN_GAP_BP}bp or more`);
  console.log(`  ${tickers.length} tickers scored, ${neverAnyBook.length} never quoted in any session\n`);

  // The aggregate claim, recomputed, so the two can be compared directly.
  console.log("AGGREGATE, median across tickers of each session median");
  const agg = {};
  for (const s of SESSIONS) {
    const vals = tickers.map((t) => t.per[s]).filter((v) => v !== null);
    agg[s] = median(vals);
    console.log(`  ${s.padEnd(11)} ${f(agg[s], 2).padStart(7)}bp   from ${vals.length} tickers`);
  }
  if (agg.regular && agg.premarket) {
    console.log(`  pre-market is ${(((agg.premarket - agg.regular) / agg.regular) * 100).toFixed(0)}% more than US hours on the typical ticker`);
  }

  console.log("\nPER TICKER, where the cheapest session actually falls");
  const decisive = tickers.filter((t) => !t.flat);
  const flat = tickers.filter((t) => t.flat);
  console.log(`  ${flat.length} of ${tickers.length} tickers are flat, no session beats another by ${MIN_GAP_BP}bp`);
  console.log(`  ${decisive.length} of ${tickers.length} have a session that genuinely wins\n`);

  const counts = Object.fromEntries(SESSIONS.map((s) => [s, 0]));
  for (const t of decisive) counts[t.best]++;
  for (const s of SESSIONS) {
    console.log(`  cheapest in ${s.padEnd(11)} ${String(counts[s]).padStart(3)} tickers  ${pct(counts[s], decisive.length)} of those with a real difference`);
  }

  console.log("\nSPLIT BY MEASURED rTOKEN BOOK DEPTH");
  for (const tier of ["deep", "mid", "shallow"]) {
    const grp = tickers.filter((t) => t.tier === tier);
    const dec = grp.filter((t) => !t.flat);
    const c = Object.fromEntries(SESSIONS.map((s) => [s, 0]));
    for (const t of dec) c[t.best]++;
    const depths = grp.map((t) => t.depth).filter(Boolean);
    console.log(`\n  ${tier.toUpperCase()}  ${grp.length} tickers, median book $${Math.round(median(depths) ?? 0).toLocaleString()}`);
    console.log(`    flat: ${grp.length - dec.length}, decisive: ${dec.length}`);
    for (const s of SESSIONS) {
      if (!c[s]) continue;
      console.log(`    cheapest in ${s.padEnd(11)} ${String(c[s]).padStart(3)}  ${pct(c[s], dec.length)}`);
    }
    const inv = dec.filter((t) => t.invertsHeadline);
    console.log(`    invert the headline (cheapest outside US hours): ${inv.length} of ${dec.length}  ${pct(inv.length, dec.length)}`);
    if (inv.length) console.log(`      ${inv.slice(0, 14).map((t) => t.ticker).join(" ")}${inv.length > 14 ? " ..." : ""}`);
  }

  console.log("\nTHE 20 DEEPEST rTOKEN BOOKS, session by session");
  console.log("  ticker  |   book $ |  premkt |  US hrs |  after |  overngt |  cheapest   | spread");
  console.log("  " + "-".repeat(88));
  for (const t of tickers.slice(0, 20)) {
    console.log(
      "  " + [
        t.ticker.padEnd(7),
        ("$" + Math.round(t.depth).toLocaleString()).padStart(8),
        f(t.per.premarket, 1).padStart(7),
        f(t.per.regular, 1).padStart(7),
        f(t.per.afterhours, 1).padStart(6),
        f(t.per.overnight, 1).padStart(8),
        (t.flat ? "flat" : t.best).padEnd(11),
        (t.flat ? "-" : f(t.spread, 1) + "bp").padStart(6),
      ].join(" | "),
    );
  }

  console.log("\nHOW OFTEN IS US HOURS THE ANSWER");
  const dec = decisive.filter((t) => t.regular !== null);
  const usWins = dec.filter((t) => t.best === "regular").length;
  console.log(`  US hours is cheapest for ${usWins} of ${dec.length} tickers with a real difference  ${pct(usWins, dec.length)}`);
  console.log(`  something else is cheapest for ${dec.length - usWins}  ${pct(dec.length - usWins, dec.length)}`);
  const deepDec = dec.filter((t) => t.tier === "deep");
  const deepUs = deepDec.filter((t) => t.best === "regular").length;
  console.log(`  among the deepest third: US hours wins ${deepUs} of ${deepDec.length}  ${pct(deepUs, deepDec.length)}`);
  console.log(`\n${line}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
