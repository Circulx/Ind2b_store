#!/usr/bin/env node
/**
 * `npm run dev` — starts the platform on http://localhost:3000 against YOUR MongoDB.
 *
 * MONGODB_URI (shell, .env.local or .env) is required. Nothing is stored on this computer:
 * earlier versions started a private local MongoDB in ./.mongo-data when MONGODB_URI was not
 * found, so data never reached your real database. That fallback has been removed.
 * Data that was saved in ./.mongo-data or ./.uploads can be copied over once with
 * `npm run db:migrate-local`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dbName, loadEnv, redact, requireMongoUri, root } from "./load-env.mjs";

loadEnv(true);
requireMongoUri("npm run dev");
console.log(`▸ MongoDB: ${redact()}  ·  database "${dbName()}"`);

for (const [dir, what] of [[".mongo-data", "a local MongoDB"], [process.env.UPLOAD_DIR || ".uploads", "images on disk"]]) {
  if (fs.existsSync(path.join(root, dir))) {
    console.log(`▸ Found ./${dir} (${what} from an earlier version). Run \`npm run db:migrate-local\` once to copy it into your database.`);
  }
}

const args = ["dev", ...process.argv.slice(2)];
const child = spawn(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), ...args], { stdio: "inherit", env: process.env, cwd: root });

const stop = (code = 0) => { child.kill("SIGINT"); process.exit(code); };
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
child.on("exit", (code) => process.exit(code ?? 0));
