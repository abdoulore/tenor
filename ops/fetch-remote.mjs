#!/usr/bin/env node
/**
 * Pull the collected data down from the deployed collector.
 *
 * Collection now lives on a Railway volume, so the laptop is no longer the source of truth.
 * Everything that reads the data still runs locally: the session medians bundled into the
 * app, the per ticker session analysis, and Saturday's receipts. This is how they get it.
 *
 *   node ops/fetch-remote.mjs
 *
 * Reads COLLECTOR_URL and FETCH_TOKEN from the environment.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";

const URL_BASE = process.env.COLLECTOR_URL;
const TOKEN = process.env.FETCH_TOKEN;
const OUT = { samples: join(process.cwd(), "sampler", "data"), predictions: join(process.cwd(), "engine", "predictions") };

if (!URL_BASE || !TOKEN) {
  console.error("COLLECTOR_URL and FETCH_TOKEN must be set. They are in .env.");
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

const listing = await (await fetch(`${URL_BASE}/list?token=${TOKEN}`, { signal: AbortSignal.timeout(60_000) })).json();

let fetched = 0;
let skipped = 0;
let bytes = 0;

for (const [kind, files] of Object.entries(listing)) {
  const dir = OUT[kind];
  if (!dir) continue;
  await mkdir(dir, { recursive: true });
  for (const f of files) {
    const dest = join(dir, f.name);
    // Files are append only, so a matching size means there is nothing new to collect.
    const local = await stat(dest).catch(() => null);
    if (local && local.size === f.bytes) { skipped++; continue; }
    const res = await fetch(`${URL_BASE}/file/${kind}/${encodeURIComponent(f.name)}?token=${TOKEN}`, {
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) { log(`failed ${kind}/${f.name}: HTTP ${res.status}`); continue; }
    // Streamed to a temporary file and renamed, so a large file never sits whole in memory and
    // an interrupted download never leaves a half written file under the real name.
    const tmp = `${dest}.part`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    await rename(tmp, dest);
    const size = (await stat(dest)).size;
    fetched++;
    bytes += size;
    log(`${kind}/${f.name} ${(size / 1e6).toFixed(2)}MB`);
  }
}

log(`done: ${fetched} file(s) pulled (${(bytes / 1e6).toFixed(1)}MB), ${skipped} already current`);
