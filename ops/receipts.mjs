#!/usr/bin/env node
/**
 * Receipts: score every logged recommendation against what actually happened.
 *
 * The honest problem this has to work around is that every prediction carries a 30 day
 * horizon and the oldest is two days old, so "was the 30 day cost right" is unanswerable and
 * claiming otherwise would be the exact dishonesty the product exists to avoid.
 *
 * Three things can be checked, and they are reported separately rather than blended into one
 * flattering score:
 *
 *   1. Accuracy      the quoted cost against what the same trade cost minutes and hours later
 *   2. Availability  when we said nobody was quoting, was that still true later
 *   3. Stability     replaying each call on later prices, does the recommendation still hold
 *
 * Funding is the fourth and it is not verifiable yet. Two days of thirty have elapsed, and
 * the report says so rather than quietly scoring it.
 *
 *   node ops/receipts.mjs [--out app/src/data/receipts.json]
 */

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const PRED_DIR = arg("--predictions", join(process.cwd(), "engine", "predictions"));
const DATA_DIR = arg("--data", join(process.cwd(), "sampler", "data"));
const OUT = arg("--out", join(process.cwd(), "app", "src", "data", "receipts.json"));

/** Lags, in minutes, at which a quoted price is re-checked against reality. */
const LAGS = [5, 30, 60, 240];
const MIN = 60_000;
/** A sample must be this close to the target instant to count as measuring it. */
const TOLERANCE_MS = 4 * MIN;

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x, dp = 3) => (x === null || x === undefined ? null : Math.round(x * 10 ** dp) / 10 ** dp);
const pct = (n, d) => (d ? round((n / d) * 100, 1) : null);

async function readNdjson(dir, prefix) {
  const files = (await readdir(dir).catch(() => []))
    .filter((f) => f.startsWith(prefix) && f.endsWith(".ndjson")).sort();
  const out = [];
  for (const f of files) {
    const text = await readFile(join(dir, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn last line is expected on a live file */ }
    }
  }
  return out;
}

/**
 * Samples indexed by ticker and sorted by time, so a lookup for "what was this worth at
 * time T" is a binary search rather than a scan of forty thousand records.
 */
function indexSamples(samples) {
  const byTicker = new Map();
  for (const s of samples) {
    const t = Date.parse(s.t);
    if (!Number.isFinite(t)) continue;
    if (!byTicker.has(s.ticker)) byTicker.set(s.ticker, []);
    byTicker.get(s.ticker).push({ t, s });
  }
  for (const arr of byTicker.values()) arr.sort((a, b) => a.t - b.t);
  return byTicker;
}

/** The sample nearest a target instant, or null when nothing was measured near it. */
function sampleAt(index, ticker, targetMs) {
  const arr = index.get(ticker);
  if (!arr?.length) return null;
  let lo = 0, hi = arr.length - 1, best = null, bestGap = Infinity;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const gap = Math.abs(arr[mid].t - targetMs);
    if (gap < bestGap) { bestGap = gap; best = arr[mid]; }
    if (arr[mid].t < targetMs) lo = mid + 1; else hi = mid - 1;
  }
  return bestGap <= TOLERANCE_MS ? best : null;
}

/*
 * A call is checked against the same kind of price it was made from. From 23 September the
 * tokenized stock is priced from Bitget's quote, which is what its orders fill at, so those
 * calls are checked against later quotes. Older calls priced it from the order book and are
 * checked against later books, which is a fair test of the call even though real trades later
 * showed the book is not what fills.
 */
const legOf = (sample, route, source) =>
  route === "rtoken" ? (source === "quote" ? sample.spotQuote : sample.spot) : sample.perp;
const costAt = (sample, route, size, source) => {
  const leg = legOf(sample, route, source);
  if (!leg || leg.empty) return null;
  const v = leg.fills?.[String(size)]?.roundTripBp;
  return typeof v === "number" ? v : null;
};
const emptyAt = (sample, route, source) => legOf(sample, route, source)?.empty === true;

/** Contiguous runs of an empty book, for names whose availability changed. */
function outagesFor(keys, index) {
  const out = [];
  for (const key of keys) {
    const [ticker, route] = key.split(":");
    let run = null;
    for (const { t, s } of index.get(ticker) ?? []) {
      if (emptyAt(s, route)) {
        if (!run) run = { ticker, route, from: s.t, to: s.t, samples: 0, sessions: new Set() };
        run.to = s.t;
        run.samples++;
        run.sessions.add(s.session);
      } else if (run) {
        out.push({ ...run, sessions: [...run.sessions] });
        run = null;
      }
      void t;
    }
    if (run) out.push({ ...run, sessions: [...run.sessions], ongoing: true });
  }
  return out;
}

async function main() {
  const predictions = await readNdjson(PRED_DIR, "predictions-");
  const samples = await readNdjson(DATA_DIR, "samples-");
  if (!predictions.length) throw new Error(`no predictions in ${PRED_DIR}`);
  const index = indexSamples(samples);

  const sizes = [...new Set(predictions.map((p) => p.notionalUsd))].sort((a, b) => a - b);

  // ------------------------------------------------------------ 1. accuracy
  //
  // What the page quoted, against what the same trade cost a few minutes later. This is the
  // number that decides whether a quote is usable, because nobody acts in the same instant
  // they read it.
  const accuracy = {};
  for (const lag of LAGS) accuracy[lag] = { errors: [], n: 0, within1bp: 0, within5bp: 0 };

  for (const p of predictions) {
    for (const r of p.routes) {
      if (typeof r.executionBp !== "number") continue;
      for (const lag of LAGS) {
        const hit = sampleAt(index, p.ticker, Date.parse(p.at) + lag * MIN);
        if (!hit) continue;
        const actual = costAt(hit.s, r.route, p.notionalUsd, r.source);
        if (actual === null) continue;
        const err = actual - r.executionBp;
        const a = accuracy[lag];
        a.errors.push(err);
        a.n++;
        if (Math.abs(err) <= 1) a.within1bp++;
        if (Math.abs(err) <= 5) a.within5bp++;
      }
    }
  }

  const accuracyOut = LAGS.map((lag) => {
    const a = accuracy[lag];
    const abs = a.errors.map(Math.abs);
    return {
      lagMinutes: lag,
      checks: a.n,
      medianErrorBp: round(median(a.errors), 3),
      medianAbsErrorBp: round(median(abs), 3),
      within1bpPct: pct(a.within1bp, a.n),
      within5bpPct: pct(a.within5bp, a.n),
    };
  });

  // ------------------------------------------------------------ 2. availability
  //
  // When a route could not be priced, was that still true an hour later, and when it could,
  // was it still priceable. Checked in both directions.
  const avail = {
    saidDead: 0, deadStillDead: 0,
    saidLive: 0, liveStillLive: 0,
    wrongDead: [], wrongLive: [],
    /* Which names were ever called dead, and did any name ever change state. A perfect
       score here means deadness is structural rather than that we are clairvoyant, and the
       report has to be able to say which. */
    deadTickers: new Set(), liveTickers: new Set(),
  };

  for (const p of predictions) {
    const later = sampleAt(index, p.ticker, Date.parse(p.at) + 60 * MIN);
    if (!later) continue;
    for (const r of p.routes) {
      if (r.route === "stockplus") continue;
      if (r.status === "no_book") {
        avail.saidDead++;
        avail.deadTickers.add(`${p.ticker}:${r.route}`);
        if (emptyAt(later.s, r.route, r.source)) avail.deadStillDead++;
        else if (avail.wrongDead.length < 20) {
          avail.wrongDead.push({ ticker: p.ticker, at: p.at, route: r.route });
        }
      } else if (r.status === "ok" || r.status === "stale") {
        avail.saidLive++;
        avail.liveTickers.add(`${p.ticker}:${r.route}`);
        if (!emptyAt(later.s, r.route, r.source)) avail.liveStillLive++;
        else if (avail.wrongLive.length < 20) {
          avail.wrongLive.push({ ticker: p.ticker, at: p.at, route: r.route });
        }
      }
    }
  }

  // ------------------------------------------------------------ 3. stability
  //
  // Replay each call on later prices, holding fees and the funding projection fixed, so the
  // only thing that moves is execution. That isolates the question a user actually cares
  // about: if I had come back an hour later, would you still tell me the same thing.
  const stability = {};
  for (const lag of LAGS) stability[lag] = { n: 0, held: 0, flips: [] };

  for (const p of predictions) {
    if (!p.route) continue;
    const priced = p.routes.filter((r) => typeof r.totalBp === "number" && typeof r.executionBp === "number");
    if (priced.length < 2) continue;

    for (const lag of LAGS) {
      const hit = sampleAt(index, p.ticker, Date.parse(p.at) + lag * MIN);
      if (!hit) continue;

      const replayed = [];
      let usable = true;
      for (const r of priced) {
        const actual = costAt(hit.s, r.route, p.notionalUsd, r.source);
        if (actual === null) { usable = false; break; }
        replayed.push({ route: r.route, total: r.totalBp - r.executionBp + actual });
      }
      if (!usable || replayed.length < 2) continue;

      replayed.sort((a, b) => a.total - b.total);
      const st = stability[lag];
      st.n++;
      if (replayed[0].route === p.route) st.held++;
      else if (st.flips.length < 40) {
        st.flips.push({
          ticker: p.ticker, at: p.at, size: p.notionalUsd,
          said: p.route, became: replayed[0].route,
          gapBp: round(Math.abs(replayed[0].total - replayed[1].total), 2),
          decidedBy: p.decidedBy,
        });
      }
    }
  }

  const stabilityOut = LAGS.map((lag) => ({
    lagMinutes: lag,
    checks: stability[lag].n,
    heldPct: pct(stability[lag].held, stability[lag].n),
    flipped: stability[lag].n - stability[lag].held,
  }));

  // ------------------------------------------------------------ assembly

  const times = predictions.map((p) => p.at).sort();
  const byGate = {};
  for (const p of predictions) byGate[p.decidedBy] = (byGate[p.decidedBy] ?? 0) + 1;
  const byRoute = {};
  for (const p of predictions) byRoute[p.route ?? "none"] = (byRoute[p.route ?? "none"] ?? 0) + 1;

  const oldestMs = Date.now() - Date.parse(times[0]);
  const horizons = [...new Set(predictions.map((p) => p.horizonDays))];

  const report = {
    generatedAt: new Date().toISOString(),
    predictions: predictions.length,
    from: times[0],
    to: times[times.length - 1],
    tickers: [...new Set(predictions.map((p) => p.ticker))].sort(),
    sizes,
    byGate,
    byRoute,
    /* How many calls priced the tokenized stock from the order book, and how many from the quote. */
    sources: (() => {
      const q = predictions.filter((p) => p.routes.some((r) => r.route === "rtoken" && r.source === "quote"));
      return {
        book: predictions.length - q.length,
        quote: q.length,
        quoteSince: q.map((p) => p.at).sort()[0] ?? null,
      };
    })(),
    accuracy: accuracyOut,
    availability: {
      saidDead: avail.saidDead,
      deadStillDeadPct: pct(avail.deadStillDead, avail.saidDead),
      saidLive: avail.saidLive,
      liveStillLivePct: pct(avail.liveStillLive, avail.saidLive),
      wrongDead: avail.wrongDead,
      wrongLive: avail.wrongLive,
      deadNames: [...avail.deadTickers].sort(),
      /* A name in both sets quoted sometimes and not others, so its state genuinely moved. */
      everChanged: [...avail.deadTickers].filter((k) => avail.liveTickers.has(k)).sort(),
      /* For each name that changed, exactly when its book was empty, from the raw samples. A
         market going dark for two hours is a finding, and "it changed" alone does not say so. */
      outages: outagesFor([...avail.deadTickers].filter((k) => avail.liveTickers.has(k)), index),
    },
    stability: stabilityOut,
    flips: stability[60].flips,
    /*
     * Stated rather than scored. Every horizon logged is 30 days and the log is a couple of
     * days old, so the funding half of every projection is still unresolved. Reporting a
     * score for it would be inventing one.
     */
    funding: {
      verifiable: false,
      horizonDays: horizons,
      elapsedDays: round(oldestMs / 86_400_000, 1),
      note:
        "Each call projects funding over 30 days. The oldest is " +
        `${(oldestMs / 86_400_000).toFixed(1)} days in. Funding is scored once a forecast ` +
        "completes, and the figures above cover trading costs.",
    },
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(report), "utf8");

  // ------------------------------------------------------------ print

  const line = "=".repeat(86);
  console.log(`\n${line}\nRECEIPTS: every recommendation, checked against what happened next\n${line}`);
  console.log(`  ${report.predictions.toLocaleString()} predictions, ${report.tickers.length} tickers, ${times[0].slice(0, 16)} to ${times[times.length - 1].slice(0, 16)}`);
  console.log(`  decided by: ${Object.entries(byGate).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`  recommended: ${Object.entries(byRoute).map(([k, v]) => `${k} ${v}`).join(", ")}`);

  console.log(`\nACCURACY: the quoted cost against what it actually cost later`);
  console.log("  after   | checks |  median error | typical miss | within 1bp | within 5bp");
  console.log("  " + "-".repeat(78));
  for (const a of accuracyOut) {
    console.log("  " + [
      `${a.lagMinutes}m`.padEnd(7),
      String(a.checks).padStart(6),
      `${a.medianErrorBp ?? "n/a"}bp`.padStart(13),
      `${a.medianAbsErrorBp ?? "n/a"}bp`.padStart(12),
      `${a.within1bpPct ?? "n/a"}%`.padStart(10),
      `${a.within5bpPct ?? "n/a"}%`.padStart(10),
    ].join(" | "));
  }

  console.log(`\nAVAILABILITY: were we right about what could be traded`);
  console.log(`  said nobody was quoting: ${avail.saidDead.toLocaleString()} calls, still true an hour later ${report.availability.deadStillDeadPct}%`);
  console.log(`  said it was tradeable:   ${avail.saidLive.toLocaleString()} calls, still true an hour later ${report.availability.liveStillLivePct}%`);
  if (avail.wrongDead.length) {
    console.log(`  called dead but quoted within the hour: ${avail.wrongDead.slice(0, 6).map((w) => w.ticker).join(" ")}`);
  }
  if (avail.wrongLive.length) {
    console.log(`  called tradeable but empty within the hour: ${avail.wrongLive.slice(0, 6).map((w) => w.ticker).join(" ")}`);
  }
  console.log(`  names ever called dead: ${report.availability.deadNames.join(" ") || "none"}`);
  console.log(`  names whose availability ever changed: ${report.availability.everChanged.join(" ") || "none"}`);
  if (!report.availability.everChanged.length) {
    console.log(`  reading: nothing ever switched, so this measures how structural deadness is,`);
    console.log(`           not how well anything was predicted. Say it that way.`);
  }

  console.log(`\nSTABILITY: would we still have said the same thing`);
  console.log("  after   | checks | same answer | changed");
  console.log("  " + "-".repeat(48));
  for (const st of stabilityOut) {
    console.log("  " + [
      `${st.lagMinutes}m`.padEnd(7),
      String(st.checks).padStart(6),
      `${st.heldPct ?? "n/a"}%`.padStart(11),
      String(st.flipped).padStart(7),
    ].join(" | "));
  }

  if (report.flips.length) {
    console.log(`\n  THE CALLS THAT CHANGED within an hour, first ${Math.min(8, report.flips.length)}:`);
    for (const f of report.flips.slice(0, 8)) {
      console.log(`    ${f.ticker.padEnd(6)} $${String(f.size).padEnd(6)} said ${f.said.padEnd(7)} became ${f.became.padEnd(7)} by ${f.gapBp}bp`);
    }
  }

  console.log(`\nNOT VERIFIABLE YET`);
  console.log(`  ${report.funding.note}`);
  console.log(`\nwrote ${OUT}, ${(Buffer.byteLength(JSON.stringify(report)) / 1024).toFixed(1)} KB\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
