#!/usr/bin/env node
/**
 * Hourly backup of the two things in this project that cannot be regenerated.
 *
 * The sampled orderbook data and the prediction log are both append only records of moments
 * that have passed. Everything else here could be rebuilt in a day. These could not be
 * rebuilt at all.
 *
 * Zero dependencies.
 *
 *   node ops/backup.mjs --once
 *   node ops/backup.mjs                    hourly, forever
 *   node ops/backup.mjs --dest D:/tenor    explicit destination
 *
 * Destination resolution, first that is set:
 *   --dest, BACKUP_DIR, then a local fallback with a loud warning.
 *
 * A destination on the same physical disk as the source is NOT off machine protection. It
 * survives an accidental delete or a corrupt write. It does not survive the machine dying,
 * which is the risk that actually matters here. The script says so on every run rather than
 * letting a green line imply safety it cannot provide.
 */

import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, parse, resolve } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const ARGS = new Set(process.argv.slice(2));

const ROOT = process.cwd();
const SOURCES = [
  { name: "samples", dir: join(ROOT, "sampler", "data"), match: /^samples-.*\.ndjson$/ },
  { name: "predictions", dir: join(ROOT, "engine", "predictions"), match: /^predictions-.*\.ndjson$/ },
];

const DEST = resolve(arg("--dest", process.env.BACKUP_DIR ?? join(ROOT, ".backup")));
const INTERVAL_MS = Number(arg("--interval", process.env.BACKUP_INTERVAL_MS ?? 3_600_000));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Same volume means an accidental-delete backup, not a machine-death backup. */
function sameVolume(a, b) {
  const va = parse(resolve(a)).root.toLowerCase();
  const vb = parse(resolve(b)).root.toLowerCase();
  return va === vb;
}

async function sha256(path) {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

async function backupOnce() {
  const startedAt = new Date();
  await mkdir(DEST, { recursive: true });

  const manifest = { at: startedAt.toISOString(), dest: DEST, files: [], offMachine: !sameVolume(ROOT, DEST) };
  let copied = 0;
  let skipped = 0;
  let bytes = 0;

  for (const src of SOURCES) {
    let names = [];
    try {
      names = (await readdir(src.dir)).filter((f) => src.match.test(f));
    } catch {
      log(`source missing: ${src.dir}`);
      continue;
    }
    const outDir = join(DEST, src.name);
    await mkdir(outDir, { recursive: true });

    for (const name of names) {
      const from = join(src.dir, name);
      const to = join(outDir, name);
      const s = await stat(from);

      // Append only files grow. Copy only when size differs, which is cheap and correct here.
      let needed = true;
      try {
        const existing = await stat(to);
        needed = existing.size !== s.size;
      } catch { /* not backed up yet */ }

      if (!needed) { skipped++; continue; }
      await copyFile(from, to);
      const digest = await sha256(to);
      const verify = await sha256(from);
      if (digest !== verify) {
        // The source is still being appended to, so a mismatch here is expected occasionally
        // and is reported rather than treated as corruption.
        log(`checksum moved during copy for ${name}, will settle next run`);
      }
      manifest.files.push({ source: src.name, name, bytes: s.size, sha256: digest });
      copied++;
      bytes += s.size;
    }
  }

  await writeFile(join(DEST, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const mb = (bytes / 1e6).toFixed(1);
  log(`backup: ${copied} copied (${mb} MB), ${skipped} unchanged, dest ${DEST}`);
  if (!manifest.offMachine) {
    log("WARNING destination is on the same volume as the source. This protects against an");
    log("WARNING accidental delete only. It does NOT protect against this machine dying,");
    log("WARNING which is the risk that matters. Set BACKUP_DIR to a synced or remote path.");
  }
  return { copied, skipped, bytes, offMachine: manifest.offMachine };
}

async function main() {
  log(`backing up to ${DEST}, every ${Math.round(INTERVAL_MS / 60000)} min`);
  for (;;) {
    try {
      await backupOnce();
    } catch (e) {
      log(`backup failed: ${e?.message ?? e}`);
    }
    if (ARGS.has("--once")) return;
    await sleep(INTERVAL_MS);
  }
}

main().catch((e) => { log("fatal", e); process.exit(1); });
