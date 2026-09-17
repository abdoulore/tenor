#!/usr/bin/env node
/**
 * Supervisor for the two collectors, so one container holds both against one volume.
 *
 * The sampler and the prediction logger share state: the logger reads the sampler's NDJSON
 * to build its session outlook. A Railway volume attaches to a single service, so running
 * both here keeps them on the same disk rather than splitting them across two volumes that
 * cannot see each other.
 *
 * Neither child is allowed to take the container down. Both are restarted with backoff,
 * because every minute either is dead is data that cannot be recovered later.
 *
 *   node ops/run-all.mjs
 */

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join, basename } from "node:path";

const DATA_DIR = process.env.DATA_DIR ?? "/data/samples";
const PRED_DIR = process.env.PRED_DIR ?? "/data/predictions";
const SEED_FROM = process.env.SEED_FROM ?? null;

const log = (...a) => console.log(new Date().toISOString(), "[supervisor]", ...a);

/**
 * On a fresh volume, copy any history baked into the image across once.
 *
 * Without this the deployed collector starts from zero and the record splits in two: two
 * days on a laptop, the rest in the cloud. Seeding keeps one continuous series. It only ever
 * runs when the destination is empty, so a redeploy never overwrites collected data.
 */
async function seedOnce(from, to, label) {
  if (!from) return;
  try {
    const src = (await readdir(from).catch(() => [])).filter((f) => f.endsWith(".ndjson"));
    if (!src.length) { log(`${label}: nothing to seed from ${from}`); return; }
    await mkdir(to, { recursive: true });
    const existing = new Set(await readdir(to).catch(() => []));

    let copied = 0;
    let archived = 0;
    for (const f of src) {
      if (!existing.has(f)) {
        await cp(join(from, f), join(to, f));
        copied++;
        continue;
      }
      /*
       * Same filename on both sides means the same calendar day was collected in two
       * places, typically the day of the migration. Neither copy is a superset of the
       * other, so the image's copy is kept alongside under a distinct name rather than
       * overwriting live data or being silently dropped. Analysis globs samples-*.ndjson
       * and picks up both.
       */
      const archiveName = f.replace(/\.ndjson$/, ".preflight.ndjson");
      if (!existing.has(archiveName)) {
        await cp(join(from, f), join(to, archiveName));
        archived++;
      }
    }
    if (copied || archived) {
      log(`${label}: seeded ${copied} file(s), archived ${archived} overlapping day(s) from the image`);
    } else {
      log(`${label}: volume already holds everything the image carried`);
    }
  } catch (e) {
    log(`${label}: seeding failed, continuing anyway: ${e?.message ?? e}`);
  }
}

function supervise(name, args, env) {
  let attempt = 0;
  const start = () => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (code, signal) => {
      attempt++;
      // Cap the backoff so a persistent failure still retries every 30s rather than
      // drifting out to hours and quietly stopping collection.
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      log(`${name} exited (code ${code}, signal ${signal}), restarting in ${delay / 1000}s`);
      setTimeout(start, delay);
    });
    child.on("error", (e) => log(`${name} failed to spawn: ${e.message}`));
    log(`${name} started, pid ${child.pid}`);
  };
  start();
}

/**
 * Read only file server for the collected data.
 *
 * Once collection lives in the cloud, the data has to come back down: the session medians
 * bundled into the app are rebuilt from it, and Saturday's receipts are read from the
 * prediction log. Without this the durable copy would be the unreachable one.
 *
 * Requires a shared token, because this is collected market data behind a public URL, and
 * an open directory listing is not something to leave running over a weekend.
 */
function serveFiles() {
  const token = process.env.FETCH_TOKEN;
  const port = Number(process.env.PORT ?? 8080);
  if (!token) {
    log("FETCH_TOKEN not set, file server disabled");
    return;
  }

  const roots = { samples: DATA_DIR, predictions: PRED_DIR };

  createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    // Health is unauthenticated so the platform can probe it. It exposes counts, not data.
    if (url.pathname === "/health") {
      const out = {};
      for (const [name, dir] of Object.entries(roots)) {
        const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".ndjson"));
        let bytes = 0;
        for (const f of files) bytes += (await stat(join(dir, f)).catch(() => ({ size: 0 }))).size;
        out[name] = { files: files.length, bytes };
      }
      return send(200, { ok: true, at: new Date().toISOString(), ...out });
    }

    if (url.searchParams.get("token") !== token) return send(401, { error: "unauthorized" });

    if (url.pathname === "/list") {
      const out = {};
      for (const [name, dir] of Object.entries(roots)) {
        const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".ndjson"));
        out[name] = [];
        for (const f of files) {
          const s = await stat(join(dir, f)).catch(() => null);
          out[name].push({ name: f, bytes: s?.size ?? 0, modified: s?.mtime ?? null });
        }
      }
      return send(200, out);
    }

    const m = url.pathname.match(/^\/file\/(samples|predictions)\/(.+)$/);
    if (m) {
      // basename strips any traversal attempt before it reaches the filesystem.
      const file = join(roots[m[1]], basename(m[2]));
      if (!file.endsWith(".ndjson")) return send(400, { error: "only ndjson" });
      const s = await stat(file).catch(() => null);
      if (!s) return send(404, { error: "not found" });
      res.writeHead(200, { "content-type": "application/x-ndjson", "content-length": s.size });
      return createReadStream(file).pipe(res);
    }

    return send(404, { error: "not found" });
  }).listen(port, () => log(`file server on ${port}, /health /list /file/{samples|predictions}/{name}`));
}

async function main() {
  log(`data ${DATA_DIR}`);
  log(`predictions ${PRED_DIR}`);

  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(PRED_DIR, { recursive: true });
  if (SEED_FROM) {
    await seedOnce(join(SEED_FROM, "sampler", "data"), DATA_DIR, "samples");
    await seedOnce(join(SEED_FROM, "engine", "predictions"), PRED_DIR, "predictions");
  }

  serveFiles();

  supervise("sampler", ["sampler/sample.mjs", "--data", DATA_DIR], {});
  // Staggered so the two are not hammering Bitget in the same instant on every boot.
  setTimeout(() => {
    supervise("logger", ["engine/logger.ts", "--data", DATA_DIR, "--predictions", PRED_DIR], {});
  }, 20_000);
}

// A crash here takes both collectors with it, so nothing is allowed to escape.
main().catch((e) => {
  log("fatal in supervisor", e);
  process.exitCode = 1;
});
process.on("unhandledRejection", (e) => log("unhandled rejection", e));
process.on("uncaughtException", (e) => log("uncaught exception", e));
