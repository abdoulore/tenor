#!/usr/bin/env node
/**
 * Compress the sampled NDJSON into the small file the deployed app ships.
 *
 * The samples are tens of megabytes and grow hourly. The app only needs, per ticker per
 * session per size, the median round trip execution cost and how often the book was empty.
 * That is a few tens of kilobytes, so it is precomputed here and bundled.
 *
 * Re-run whenever the app is redeployed, so the shipped medians are not older than the
 * claim the page makes about them. The output records its own coverage window for exactly
 * that reason.
 *
 *   node ops/build-outlook.mjs
 */

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const DATA_DIR = arg("--data", join(process.cwd(), "sampler", "data"));
const OUT = arg("--out", join(process.cwd(), "app", "src", "data", "outlook.json"));
/* Must match sampler/depth.mjs. Older records carry only 2000 and 10000, so a size with no
   samples for a ticker comes out null rather than being filled in from a neighbour. */
const SIZES = ["500", "2000", "10000", "50000"];
const SESSIONS = ["premarket", "regular", "afterhours", "overnight", "weekend"];

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round = (x, dp = 3) => (x === null ? null : Math.round(x * 10 ** dp) / 10 ** dp);

async function main() {
  const MIN_QUOTE_SAMPLES = 6;
  const files = (await readdir(DATA_DIR))
    .filter((f) => f.startsWith("samples-") && f.endsWith(".ndjson")).sort();
  if (!files.length) throw new Error(`no sample files in ${DATA_DIR}`);

  /** ticker -> route -> session -> size -> { rt: [], empty, n } */
  const acc = new Map();
  let rows = 0;
  let quoteSince = null;
  let quoteRows = 0;
  let firstAt = null;
  let lastAt = null;
  const cycles = new Set();

  for (const f of files) {
    const text = await readFile(join(DATA_DIR, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      rows++;
      cycles.add(r.cycle);
      if (!firstAt || r.t < firstAt) firstAt = r.t;
      if (!lastAt || r.t > lastAt) lastAt = r.t;

      if (!acc.has(r.ticker)) acc.set(r.ticker, { rtoken: {}, perp: {}, control: !!r.control });
      const t = acc.get(r.ticker);
      if (r.spotQuote) {
        quoteRows++;
        if (!quoteSince || r.t < quoteSince) quoteSince = r.t;
      }
      /*
       * The tokenized stock is measured from its quote, which is what its orders fill at. Older
       * records only carry its order book, which real trades showed overstates the cost, so for
       * this route they are left out rather than mixed in. The perpetual uses its book as before.
       */
      for (const [route, leg] of [["rtoken", r.spotQuote], ["perp", r.perp]]) {
        if (route === "rtoken" && !leg) continue;
        const bySession = t[route];
        if (!bySession[r.session]) {
          bySession[r.session] = { n: 0, empty: 0, sizes: Object.fromEntries(SIZES.map((s) => [s, []])) };
        }
        const b = bySession[r.session];
        b.n++;
        if (leg?.empty) b.empty++;
        for (const size of SIZES) {
          const v = leg?.fills?.[size]?.roundTripBp;
          if (typeof v === "number") b.sizes[size].push(v);
        }
      }
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    coverage: { from: firstAt, to: lastAt, records: rows, cycles: cycles.size, files: files.length },
    /** When the tokenized stock's quote was first recorded; its hour by hour figures start here. */
    quoteCoverage: { from: quoteSince, records: quoteRows },
    sizes: SIZES.map(Number),
    sessions: SESSIONS,
    tickers: {},
  };

  for (const [ticker, routes] of [...acc].sort((a, b) => a[0].localeCompare(b[0]))) {
    const entry = { control: routes.control, rtoken: {}, perp: {} };
    for (const route of ["rtoken", "perp"]) {
      for (const session of SESSIONS) {
        const b = routes[route][session];
        if (!b || b.n === 0) continue;
        // Quote recording started on 23 September. Half an hour of it in a session is the least
        // worth showing; less than that and the session reads as not measured yet.
        if (route === "rtoken" && b.n < MIN_QUOTE_SAMPLES) continue;
        entry[route][session] = {
          samples: b.n,
          emptyShare: round(b.empty / b.n, 4),
          bp: Object.fromEntries(SIZES.map((s) => [s, round(median(b.sizes[s]), 3)])),
        };
      }
    }
    out.tickers[ticker] = entry;
  }

  await mkdir(join(OUT, ".."), { recursive: true });
  await writeFile(OUT, JSON.stringify(out), "utf8");

  const bytes = Buffer.byteLength(JSON.stringify(out));
  console.log(`outlook: ${Object.keys(out.tickers).length} tickers, ${rows} records, ${cycles.size} cycles`);
  console.log(`coverage ${firstAt} to ${lastAt}`);
  console.log(`wrote ${OUT}, ${(bytes / 1024).toFixed(1)} KB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
