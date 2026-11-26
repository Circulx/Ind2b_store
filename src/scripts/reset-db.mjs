#!/usr/bin/env node
/**
 * `npm run db:reset` — deletes all IND2B data in the database named by MONGODB_URI / MONGODB_DB,
 * so demo data is seeded again on the next request (when SEED_DEMO_DATA is not "false").
 * Add --yes to skip the confirmation.
 */
import readline from "node:readline/promises";
import { dbName, loadEnv, redact, requireMongoUri } from "./load-env.mjs";

loadEnv(true);
const uri = requireMongoUri("npm run db:reset");
const name = dbName();

if (!process.argv.includes("--yes")) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`This deletes ALL data in database "${name}" at ${redact()}. Type "reset" to continue: `);
  rl.close();
  if (a.trim() !== "reset") { console.log("Cancelled."); process.exit(0); }
}

const { default: mongoose } = await import("mongoose");
await mongoose.connect(uri, { dbName: name, serverSelectionTimeoutMS: 10_000 });
await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
console.log(`Database "${name}" dropped. Demo data is seeded again on the next request.`);
