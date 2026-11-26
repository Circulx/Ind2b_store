#!/usr/bin/env node
/**
 * `npm run verify:access` — checks the whole access-control system against a RUNNING dev server and its database.
 *
 *   1. Database: connects with MONGODB_URI, checks the user/session indexes and that an active super admin exists.
 *   2. Route matrix: for every portal page, requests it as anonymous / merchant / admin / super admin and compares the result
 *      with what is allowed (200 or the expected redirect).
 *   3. Security cases: revoked session, disabled account, forged role claim, wrong signing key, shopper token used as platform
 *      token, idle staff session, Bearer API access.
 *
 * It signs in by creating real session documents for the demo accounts (priya@example.in, neha@ind2b.com, root@ind2b.com),
 * so the demo data must exist (SEED_DEMO_DATA=true on an empty database). Sessions it creates are removed again.
 * Development only: it refuses to run when NODE_ENV=production.
 *
 *   npm run dev            (in one terminal)
 *   npm run verify:access  (in another)       BASE_URL=http://localhost:3000 by default
 */
import { randomBytes } from "node:crypto";
import { dbName, loadEnv, redact, requireMongoUri } from "./load-env.mjs";

loadEnv(true);
if (process.env.NODE_ENV === "production") { console.error("verify:access is for development only."); process.exit(1); }
requireMongoUri("npm run verify:access");

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const { default: mongoose } = await import("mongoose");
const { SignJWT } = await import("jose");

const secretValue = process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "dev-only-secret-change-me-dev-only-secret";
const key = (s) => new TextEncoder().encode(s);
const COOKIE = "ind2b_session";

let pass = 0, fail = 0;
const failures = [];
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; failures.push(`${label} ${detail}`); console.log(`  ✗ ${label} ${detail}`); }
};

console.log(`\nDatabase "${dbName()}" at ${redact()}\nServer ${BASE}\n`);
// /pricing reads the plans from MongoDB, so the app connects, builds its indexes and seeds before the checks below.
await fetch(`${BASE}/pricing`, { signal: AbortSignal.timeout(120_000) }).then((r) => r.arrayBuffer()).catch(() => {
  console.error(`The server at ${BASE} did not answer. Start it with "npm run dev" first.`); process.exit(1);
});
await new Promise((r) => setTimeout(r, 1500));
await mongoose.connect(process.env.MONGODB_URI, { dbName: dbName(), serverSelectionTimeoutMS: 10_000 });
const db = mongoose.connection.db;
const users = db.collection("users");
const sessions = db.collection("sessions");
const created = [];

/* ---------------------------------------------------------------- 1. database */
console.log("1. Database");
const idx = async (col) => (await db.collection(col).indexes()).map((i) => ({ key: Object.keys(i.key).join(","), unique: !!i.unique, ttl: i.expireAfterSeconds }));
const uIdx = await idx("users");
ok(uIdx.some((i) => i.key === "email" && i.unique), "users: unique index on email");
const sIdx = await idx("sessions");
ok(sIdx.some((i) => i.key === "userId"), "sessions: index on userId");
ok(sIdx.some((i) => i.key === "expiresAt" && i.ttl === 0), "sessions: TTL index on expiresAt");
ok((await idx("customers")).some((i) => i.key === "storeId,email" && i.unique), "customers: unique (storeId, email)");
ok((await idx("stores")).some((i) => i.key === "slug" && i.unique), "stores: unique slug");
ok((await idx("auditlogs")).some((i) => i.key === "at"), "auditlogs: index on at (newest-first reads)");
ok((await users.countDocuments({ role: "superadmin", status: { $ne: "disabled" } })) >= 1, "at least one active super admin exists");
ok((await users.countDocuments({ passwordHash: { $not: /^\$2[aby]\$/ } })) === 0, "every password is a bcrypt hash");

const find = (email) => users.findOne({ email });
const [merchant, admin, superadmin] = await Promise.all([find("priya@example.in"), find("neha@ind2b.com"), find("root@ind2b.com")]);
if (!merchant || !admin || !superadmin) {
  console.error("\nThe demo accounts were not found. Use an EMPTY database with SEED_DEMO_DATA=true, or edit this script.");
  await mongoose.disconnect(); process.exit(1);
}

/* ---------------------------------------------------------------- session helpers */
async function sign(user, sid, over = {}) {
  return new SignJWT({ name: user.name, email: user.email, role: over.role ?? user.role, sid })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuer(over.iss ?? "ind2b").setAudience(over.aud ?? "ind2b:platform")
    .setSubject(user._id).setJti(sid).setIssuedAt().setExpirationTime("1h").sign(key(over.secret ?? secretValue));
}
async function login(user, over = {}) {
  const sid = randomBytes(24).toString("base64url");
  const now = new Date();
  await sessions.insertOne({ _id: sid, userId: user._id, role: user.role, kind: "platform", createdAt: now, lastSeenAt: over.lastSeenAt ?? now, expiresAt: new Date(now.getTime() + 3600_000), ip: "127.0.0.1", userAgent: "verify-access" });
  created.push(sid);
  return { sid, token: await sign(user, sid, over) };
}

async function hit(path, token, { bearer = false, method = "GET" } = {}) {
  const headers = {};
  if (token) headers[bearer ? "authorization" : "cookie"] = bearer ? `Bearer ${token}` : `${COOKIE}=${token}`;
  const r = await fetch(BASE + path, { method, headers, redirect: "manual", signal: AbortSignal.timeout(90_000) });
  const loc = r.headers.get("location");
  await r.arrayBuffer().catch(() => {});
  return { status: r.status, to: loc ? new URL(loc, BASE).pathname + new URL(loc, BASE).search : "" };
}
const isRedirect = (r, to) => r.status >= 300 && r.status < 400 && (!to || r.to.startsWith(to));

/* ---------------------------------------------------------------- ids for dynamic routes */
const [store, order, product, aUser] = await Promise.all([
  db.collection("stores").findOne({ ownerId: merchant._id }), db.collection("orders").findOne({}), db.collection("products").findOne({}), users.findOne({ role: "merchant" }),
]);

const tokens = {
  merchant: (await login(merchant)).token,
  admin: (await login(admin)).token,
  superadmin: (await login(superadmin)).token,
};

/* ---------------------------------------------------------------- 2. route matrix */
const SUPER = ["", "/account", "/audit", "/discounts", "/kyc", "/orders", `/orders/${order?._id}`, "/plans", "/plugins", "/products", "/sessions", "/shoppers", "/stores", `/stores/${store?._id}`, "/system", "/templates", "/users", `/users/${aUser?._id}`].map((p) => "/superadmin" + p);
const ADMIN_ANY = ["", "/account", "/apps", "/kyc", "/plans", "/stores", `/stores/${store?._id}`, "/templates"].map((p) => "/admin" + p);
const ADMIN_SUPER_ONLY = ["/users", `/users/${aUser?._id}`, "/customers", "/audit"].map((p) => "/admin" + p);
const MERCHANT = ["", "/account", "/analytics", "/apps", "/customers", "/discounts", "/online-store", "/orders", `/orders/${order?._id}`, "/products", `/products/${product?._id}`, "/quotes", "/settings"].map((p) => "/dashboard" + p).concat("/dashboard/editor");
const PUBLIC = ["/", "/pricing", "/templates", "/plugins", "/login", "/signup", "/forgot-password", "/admin/login", "/admin/forgot-password", "/superadmin/login", "/superadmin/forgot-password", `/store/${store?.slug}`];

console.log("\n2. Route matrix  (anonymous / merchant / admin / super admin)");
const who = { anonymous: undefined, merchant: tokens.merchant, admin: tokens.admin, superadmin: tokens.superadmin };
for (const p of PUBLIC) { const r = await hit(p); ok(r.status === 200, `public ${p}`, `-> ${r.status}`); }

for (const [name, token] of Object.entries(who)) {
  console.log(`\n  as ${name}`);
  for (const p of SUPER) {
    const r = await hit(p, token);
    name === "superadmin" ? ok(r.status === 200, `${p} 200`, `-> ${r.status} ${r.to}`) : ok(isRedirect(r, "/superadmin/login"), `${p} blocked`, `-> ${r.status} ${r.to}`);
  }
  for (const p of ADMIN_ANY) {
    const r = await hit(p, token);
    name === "admin" || name === "superadmin" ? ok(r.status === 200, `${p} 200`, `-> ${r.status} ${r.to}`) : ok(isRedirect(r, "/admin/login"), `${p} blocked`, `-> ${r.status} ${r.to}`);
  }
  for (const p of ADMIN_SUPER_ONLY) {
    const r = await hit(p, token);
    if (name === "superadmin") ok(r.status === 200, `${p} 200`, `-> ${r.status} ${r.to}`);
    else if (name === "admin") ok(isRedirect(r, "/admin?denied=1"), `${p} denied for admin`, `-> ${r.status} ${r.to}`);
    else ok(isRedirect(r, "/admin/login"), `${p} blocked`, `-> ${r.status} ${r.to}`);
  }
  for (const p of MERCHANT) {
    const r = await hit(p, token);
    // /dashboard/quotes only exists when the B2B Wholesale plugin is installed on the store.
    const expect = p === "/dashboard/quotes" && !(store?.installedApps ?? []).includes("b2b-wholesale") ? 404 : 200;
    name === "merchant" ? ok(r.status === expect, `${p} ${expect}`, `-> ${r.status} ${r.to}`) : ok(isRedirect(r, "/login"), `${p} blocked`, `-> ${r.status} ${r.to}`);
  }
}

/* ---------------------------------------------------------------- 3. security cases */
console.log("\n3. Security cases");
{
  const s = await login(superadmin);
  ok((await hit("/superadmin", s.token)).status === 200, "fresh super admin session works");
  await sessions.deleteOne({ _id: s.sid });
  ok(isRedirect(await hit("/superadmin", s.token), "/superadmin/login"), "revoked session is rejected immediately");
}
{
  const s = await login(admin);
  await users.updateOne({ _id: admin._id }, { $set: { status: "disabled" } });
  const r = await hit("/admin", s.token);
  await users.updateOne({ _id: admin._id }, { $set: { status: "active" } });
  ok(isRedirect(r, "/admin/login"), "disabled account is rejected immediately");
}
{
  const s = await login(admin, { role: "superadmin" });          // admin account, token claims superadmin
  ok(isRedirect(await hit("/superadmin", s.token), "/superadmin/login"), "forged role claim (admin → superadmin) is rejected");
}
{
  const s = await login(merchant, { role: "admin" });
  ok(isRedirect(await hit("/admin", s.token), "/admin/login"), "forged role claim (merchant → admin) is rejected");
}
{
  const s = await login(superadmin, { secret: "x".repeat(40) });
  ok(isRedirect(await hit("/superadmin", s.token), "/superadmin/login"), "token signed with another key is rejected");
}
{
  const s = await login(superadmin, { aud: `ind2b:customer:${store?._id}` });
  ok(isRedirect(await hit("/superadmin", s.token), "/superadmin/login"), "shopper-audience token is not a platform token");
}
{
  const s = await login(admin, { lastSeenAt: new Date(Date.now() - 3 * 3600_000) });
  ok(isRedirect(await hit("/admin", s.token), "/admin/login"), "idle staff session (3 h) is signed out");
}
{
  const s = await login(merchant);
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { authorization: `Bearer ${s.token}` }, signal: AbortSignal.timeout(60_000) });
  ok(me.status === 200, "Bearer token accepted by /api/auth/me", `-> ${me.status}`);
  const anon = await fetch(`${BASE}/api/auth/me`, { signal: AbortSignal.timeout(60_000) });
  ok(anon.status === 401, "/api/auth/me without token is 401", `-> ${anon.status}`);
  const kyc = await hit("/api/kyc", undefined);
  ok(kyc.status === 401, "/api/kyc without token is 401", `-> ${kyc.status}`);
  const up = await hit("/api/uploads", tokens.superadmin, { bearer: true, method: "POST" });
  ok(up.status === 401 || up.status === 403, "/api/uploads refuses a super admin token (merchant only)", `-> ${up.status}`);
}

/* ---------------------------------------------------------------- 4. real sign-in forms */
// The forms are posted the way a browser without JavaScript does (React's progressive-enhancement fields), from a test IP
// (the dev server trusts X-Forwarded-For) so the rate-limit counters it touches can be removed afterwards.
console.log("\n4. Sign-in forms (real login actions)");
const TEST_IP = "203.0.113.77";
const PW = { root: "Super@Admin2026", neha: "Admin@1234", priya: "Demo@1234" };
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
async function submit(path, fields) {
  const page = await fetch(BASE + path, { headers: { "x-forwarded-for": TEST_IP }, signal: AbortSignal.timeout(90_000) });
  const form = (await page.text()).match(/<form[\s\S]*?<\/form>/)?.[0] ?? "";
  const fd = new FormData();
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\s*\/?>/g)) fd.append(unesc(m[1]), unesc(m[2] ?? ""));
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const r = await fetch(BASE + path, { method: "POST", body: fd, redirect: "manual", headers: { "x-forwarded-for": TEST_IP }, signal: AbortSignal.timeout(90_000) });
  const cookie = r.headers.getSetCookie().map((c) => new RegExp(`^${COOKIE}=([^;]*)`).exec(c)?.[1]).find((v) => v);
  const loc = r.headers.get("location");
  return { status: r.status, to: loc ? new URL(loc, BASE).pathname : "", cookie, text: r.status === 200 ? unesc(await r.text()) : "" };
}
const signedIn = (r, to) => r.status >= 300 && r.status < 400 && r.to === to && !!r.cookie;
const says = (r, s) => r.status === 200 && !r.cookie && r.text.includes(s);

let r = await submit("/superadmin/login", { email: "root@ind2b.com", password: PW.root });
ok(signedIn(r, "/superadmin"), "super admin signs in at /superadmin/login", `-> ${r.status} ${r.to}`);
if (r.cookie) ok((await hit("/superadmin", r.cookie)).status === 200, "  …and the new session opens the control centre");
r = await submit("/superadmin/login", { email: "root@ind2b.com", password: "Wrong#Pass12345" });
ok(says(r, "Email or password is incorrect"), "wrong password is refused with a generic message");
r = await submit("/superadmin/login", { email: "neha@ind2b.com", password: PW.neha });
ok(says(r, "super admins only"), "admin cannot sign in to the super admin portal");
r = await submit("/superadmin/login", { email: "priya@example.in", password: PW.priya });
ok(says(r, "Email or password is incorrect"), "merchant cannot sign in to the super admin portal (and it is not revealed that the account exists)");

r = await submit("/admin/login", { email: "neha@ind2b.com", password: PW.neha });
ok(signedIn(r, "/admin"), "admin signs in at /admin/login", `-> ${r.status} ${r.to}`);
r = await submit("/admin/login", { email: "root@ind2b.com", password: PW.root });
ok(signedIn(r, "/admin"), "super admin may also sign in at /admin/login", `-> ${r.status} ${r.to}`);
r = await submit("/admin/login", { email: "priya@example.in", password: PW.priya });
ok(says(r, "Email or password is incorrect"), "merchant cannot sign in at /admin/login");

r = await submit("/login", { email: "priya@example.in", password: PW.priya });
ok(signedIn(r, "/dashboard"), "merchant signs in at /login", `-> ${r.status} ${r.to}`);
const merchantCookie = r.cookie;
r = await submit("/login", { email: "neha@ind2b.com", password: PW.neha });
ok(says(r, "staff account"), "staff are sent to the staff sign-in from /login");
r = await submit("/login", { email: "priya@example.in", password: "Wrong#Pass12345" });
ok(says(r, "Email or password is incorrect"), "merchant wrong password is refused");

await users.updateOne({ _id: admin._id }, { $set: { status: "disabled" } });
r = await submit("/admin/login", { email: "neha@ind2b.com", password: PW.neha });
await users.updateOne({ _id: admin._id }, { $set: { status: "active" } });
ok(says(r, "disabled"), "disabled account cannot sign in");

let last;
for (let i = 0; i < 7; i++) last = await submit("/admin/login", { email: "nobody-verify@example.com", password: "Wrong#Pass12345" });
ok(says(last, "Too many sign-in attempts"), "repeated wrong passwords are rate limited (5 per account / 15 min for staff)");

if (merchantCookie) {
  const out = await fetch(`${BASE}/logout`, { method: "POST", headers: { cookie: `${COOKIE}=${merchantCookie}`, origin: BASE, host: new URL(BASE).host }, redirect: "manual", signal: AbortSignal.timeout(60_000) });
  ok(out.status >= 300 && out.status < 400, "sign out (POST /logout) succeeds", `-> ${out.status}`);
  ok(isRedirect(await hit("/dashboard", merchantCookie), "/login"), "the signed-out token no longer works");
}

await db.collection("ratelimits").deleteMany({ _id: { $regex: `${TEST_IP.replace(/\./g, "\\.")}|nobody-verify` } });
await sessions.deleteMany({ ip: TEST_IP });

/* ---------------------------------------------------------------- clean up */
await sessions.deleteMany({ _id: { $in: created } });
await users.updateOne({ _id: admin._id }, { $set: { status: "active" } });
await mongoose.disconnect();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:\n  - " + failures.join("\n  - ")); process.exit(1); }
