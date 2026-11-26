#!/usr/bin/env node
/**
 * `npm run db:migrate-local` — one-time copy of data that earlier versions kept on this computer
 * into the MongoDB database named by MONGODB_URI / MONGODB_DB:
 *
 *   1. ./.mongo-data  — the private local MongoDB that `npm run dev` used to start when MONGODB_URI
 *                       was not found. Every collection (users, stores, products, orders, carts, plans,
 *                       images and KYC files in GridFS, …) is copied.
 *   2. ./.uploads     — image files saved on disk (UPLOAD_DIR). They are stored in GridFS ("media")
 *                       and their records switched to provider "mongodb".
 *
 * Safe to run more than once: documents that already exist in your database (same _id, or the same
 * unique email / store address) are kept as they are and reported as skipped. Nothing local is deleted:
 * remove ./.mongo-data and ./.uploads yourself after checking the result.
 *
 *   npm run db:migrate-local               copy
 *   npm run db:migrate-local -- --dry-run  only show what would be copied
 *
 * Step 1 needs the `mongodb-memory-server` package that earlier versions installed (it starts the old
 * local database from ./.mongo-data for reading). Stop `npm run dev` first.
 */
import fs from "node:fs";
import path from "node:path";
import { dbName, loadEnv, redact, requireMongoUri, root } from "./load-env.mjs";

loadEnv(true);
const targetUri = requireMongoUri("npm run db:migrate-local");
const targetDb = dbName();
const dryRun = process.argv.includes("--dry-run");
// Short-lived security records are not worth copying (everyone signs in again once).
const SKIP = new Set(["sessions", "ratelimits", "emailotps"]);

const { default: mongoose } = await import("mongoose");
const target = await mongoose.createConnection(targetUri, { dbName: targetDb, serverSelectionTimeoutMS: 15_000 }).asPromise();
console.log(`Target: database "${targetDb}" at ${redact(targetUri)}${dryRun ? "  (dry run: nothing is written)" : ""}\n`);

let problems = 0;

/* ------------------------------------------------------------ 1. ./.mongo-data */
const dataDir = path.join(root, ".mongo-data");
if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length) {
  let MongoMemoryServer;
  try {
    ({ MongoMemoryServer } = await import("mongodb-memory-server"));
  } catch {
    console.error("✗ ./.mongo-data exists, but `mongodb-memory-server` is not installed, so it cannot be read.");
    console.error("  Run `npm install -D mongodb-memory-server` and try again (it is only needed for this copy).\n");
    problems++;
  }
  if (MongoMemoryServer) {
    console.log("▸ Starting the old local MongoDB from ./.mongo-data (read only)…");
    const mongod = await MongoMemoryServer.create({ instance: { dbPath: dataDir, storageEngine: "wiredTiger", port: Number(process.env.MONGO_PORT || 27027) } });
    const source = await mongoose.createConnection(mongod.getUri(), { serverSelectionTimeoutMS: 15_000 }).asPromise();
    try {
      // Earlier versions always used the database "ind2b" (or MONGODB_DB) inside the local server.
      const admin = source.db.admin();
      const dbs = (await admin.listDatabases()).databases.map((d) => d.name).filter((n) => !["admin", "local", "config"].includes(n));
      for (const name of dbs) {
        const src = source.useDb(name, { useCache: false }).db;
        const collections = (await src.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((c) => !c.startsWith("system.") && !SKIP.has(c));
        if (!collections.length) continue;
        console.log(`\n  Local database "${name}" → "${targetDb}"`);
        // GridFS chunks after their files, so an interrupted run never leaves chunks without a file record.
        collections.sort((a, b) => Number(a.endsWith(".chunks")) - Number(b.endsWith(".chunks")));
        for (const coll of collections) {
          const docs = src.collection(coll).find({});
          let copied = 0, skipped = 0, batch = [];
          const flush = async () => {
            if (!batch.length) return;
            if (dryRun) { copied += batch.length; batch = []; return; }
            try {
              const r = await target.db.collection(coll).insertMany(batch, { ordered: false });
              copied += r.insertedCount;
            } catch (e) {
              // Duplicate keys (already in your database) are expected on a second run: keep the existing document.
              const inserted = e?.result?.insertedCount ?? e?.insertedCount ?? 0;
              const writeErrors = e?.writeErrors ?? e?.result?.writeErrors ?? [];
              const list = Array.isArray(writeErrors) ? writeErrors : [writeErrors];
              const dupes = list.filter((w) => (w?.code ?? w?.err?.code) === 11000).length;
              if (list.length && dupes === list.length) { copied += inserted; skipped += dupes; }
              else { console.error(`    ✗ ${coll}: ${e?.message ?? e}`); problems++; copied += inserted; skipped += list.length; }
            }
            batch = [];
          };
          for await (const d of docs) { batch.push(d); if (batch.length >= 500) await flush(); }
          await flush();
          console.log(`    ${coll.padEnd(18)} ${dryRun ? "would copy" : "copied"} ${copied}${skipped ? `, kept ${skipped} already in your database` : ""}`);
        }
      }
    } finally {
      await source.close();
      await mongod.stop({ doCleanup: false });
    }
  }
} else {
  console.log("▸ No ./.mongo-data folder: nothing to copy from a local database.");
}

/* ------------------------------------------------------------ 2. ./.uploads (images on disk) */
const uploadDir = path.resolve(root, process.env.UPLOAD_DIR || ".uploads");
const KEY_RE = /^[a-z0-9_-]{1,64}\/[a-z0-9]{24}\.webp$/;
if (fs.existsSync(uploadDir)) {
  console.log(`\n▸ Images on disk in ${path.relative(root, uploadDir) || uploadDir}`);
  const bucket = new mongoose.mongo.GridFSBucket(target.db, { bucketName: "media" });
  let stored = 0, present = 0;
  for (const storeId of fs.readdirSync(uploadDir)) {
    const dir = path.join(uploadDir, storeId);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      const key = `${storeId}/${file}`;
      if (!KEY_RE.test(key)) continue;
      if ((await bucket.find({ filename: key }).limit(1).toArray()).length) { present++; }
      else {
        if (!dryRun) {
          const data = fs.readFileSync(path.join(dir, file));
          await new Promise((resolve, reject) => {
            const up = bucket.openUploadStream(key, { metadata: { storeId, contentType: "image/webp" } });
            up.on("error", reject); up.on("finish", resolve); up.end(data);
          });
        }
        stored++;
      }
      if (!dryRun) await target.db.collection("media").updateMany({ key, provider: "local" }, { $set: { provider: "mongodb" } });
    }
  }
  console.log(`    ${dryRun ? "would store" : "stored"} ${stored} image(s) in MongoDB${present ? `, ${present} were already there` : ""}`);
} else {
  console.log("\n▸ No upload folder on disk: nothing to copy.");
}

await target.close();
console.log(problems
  ? `\nFinished with ${problems} problem(s) (see above).`
  : `\nDone.${dryRun ? "" : " Check the data in your database, then you can delete ./.mongo-data and ./.uploads."}`);
process.exit(problems ? 1 : 0);
