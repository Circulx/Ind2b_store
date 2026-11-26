#!/usr/bin/env node
/**
 * `npm run superadmin` — create a super admin, promote an existing staff account,
 * or reset a super admin's password (recovery when nobody can sign in).
 *
 * Interactive:      npm run superadmin
 * Non-interactive:  npm run superadmin -- --email owner@company.in --name "Owner" --password '...'
 *
 * Needs MONGODB_URI (shell, .env.local or .env). The password must have 12+ characters
 * with upper and lower case letters, a digit and a symbol. Every session of the account
 * is ended, so the change applies at the next sign-in at /admin/login.
 */
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { dbName, loadEnv, redact, requireMongoUri } from "./load-env.mjs";

loadEnv(true);
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; };
requireMongoUri("npm run superadmin");
console.log(`Database "${dbName()}" at ${redact()}`);

// Hidden password prompt.
let muted = false;
const out = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } });
const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
const ask = async (q, hidden = false) => {
  if (!hidden) return (await rl.question(q)).trim();
  process.stdout.write(q); muted = true;
  const a = await rl.question(""); muted = false; process.stdout.write("\n");
  return a;
};

const email = (arg("email") ?? (await ask("Super admin email: "))).trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error("That is not a valid email."); process.exit(1); }
const name = (arg("name") ?? (await ask("Name (Enter to keep / use 'Super Admin'): "))).trim().slice(0, 80);
const password = arg("password") ?? (await ask("Password (hidden): ", true));
const strong = password.length >= 12 && password.length <= 128 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password);
if (!strong) { console.error("Password too weak: use 12+ characters with upper and lower case letters, a digit and a symbol."); process.exit(1); }
if (!arg("password")) {
  const again = await ask("Repeat password: ", true);
  if (again !== password) { console.error("The passwords do not match."); process.exit(1); }
}
rl.close();

const { default: mongoose } = await import("mongoose");
const { default: bcrypt } = await import("bcryptjs");
await mongoose.connect(process.env.MONGODB_URI, { dbName: dbName(), serverSelectionTimeoutMS: 10_000 });
const db = mongoose.connection.db;
const users = db.collection("users");
const hash = await bcrypt.hash(password, 12);
const existing = await users.findOne({ email });

if (!existing) {
  const _id = `usr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  await users.insertOne({ _id, email, name: name || "Super Admin", phone: "", passwordHash: hash, role: "superadmin", status: "active", createdAt: new Date() });
  console.log(`Created super admin ${email} (${_id}). Sign in at /admin/login.`);
} else {
  if (existing.role === "merchant" && (await db.collection("stores").findOne({ ownerId: existing._id }))) {
    console.error(`${email} is a merchant who owns stores. Use a different email for the super admin.`);
    await mongoose.disconnect(); process.exit(1);
  }
  await users.updateOne({ _id: existing._id }, { $set: { role: "superadmin", status: "active", passwordHash: hash, passwordChangedAt: new Date(), ...(name ? { name } : {}) } });
  await db.collection("sessions").deleteMany({ userId: existing._id });
  console.log(`${email} is now a super admin with the new password. Existing sessions were ended. Sign in at /admin/login.`);
}
await db.collection("auditlogs").insertOne({ at: new Date(), actorId: "cli", actorName: "npm run superadmin", action: "user.superadmin_cli", target: existing?._id ?? email });
await mongoose.disconnect();
