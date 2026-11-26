/**
 * Shared by every script in this folder (dev server, db reset, super admin, migration).
 *
 * Loads .env.local / .env with the SAME parser Next.js uses (@next/env), so a value that
 * works in the app also works here (quotes, comments, `export`, Windows line endings).
 * Earlier versions used a hand-written parser: when it missed MONGODB_URI, `npm run dev`
 * silently started a local MongoDB on this computer and all data was saved there instead
 * of in your database.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");   // src/scripts -> project root

export function loadEnv(dev = true) {
  const require = createRequire(path.join(root, "package.json"));
  const { loadEnvConfig } = require("@next/env");
  loadEnvConfig(root, dev, { info: () => {}, error: console.error });
  // Strip a UTF-8 byte-order mark or stray whitespace (files saved by some Windows editors).
  for (const k of ["MONGODB_URI", "MONGODB_DB"]) {
    const v = process.env[k];
    if (typeof v === "string") process.env[k] = v.replace(/^﻿/, "").trim();
  }
}

/** The database name: MONGODB_DB, else the name in the URI path (…mongodb.net/<name>?…), else "ind2b". Same rule as src/lib/config/env.ts. */
export function dbName(uri = process.env.MONGODB_URI ?? "", explicit = process.env.MONGODB_DB) {
  if (explicit && explicit.trim()) return explicit.trim();
  const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]*\/([^?]+)/.exec(uri);
  const fromUri = m ? decodeURIComponent(m[1]).trim() : "";
  return fromUri || "ind2b";
}

/** "mongodb+srv://user:****@cluster0.abc.mongodb.net" — safe to print. */
export function redact(uri = process.env.MONGODB_URI ?? "") {
  return uri.replace(/\/\/([^:@/]+):[^@/]*@/, "//$1:****@").replace(/\?.*$/, "");
}

/** Exits with a clear message when MONGODB_URI is missing or malformed. */
export function requireMongoUri(scriptName) {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error(`\n  ${scriptName}: MONGODB_URI is not set.\n`);
    console.error("  All IND2B data is stored in MongoDB only. Add your connection string to .env.local, e.g.");
    console.error("    MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/ind2b?retryWrites=true&w=majority");
    console.error("    MONGODB_URI=mongodb://127.0.0.1:27017/ind2b        (MongoDB installed on this computer)\n");
    process.exit(1);
  }
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    console.error(`\n  ${scriptName}: MONGODB_URI must start with mongodb:// or mongodb+srv:// (got "${uri.slice(0, 20)}…").\n`);
    process.exit(1);
  }
  return uri;
}
