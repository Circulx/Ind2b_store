# MongoDB-only storage — what was fixed

## Why data was not reaching your database
1. **`npm run dev` silently used a database on your computer.** When `src/scripts/dev.mjs` could not read
   `MONGODB_URI` from `.env.local` (its own simple parser fails on a file saved with a byte-order mark, a line
   starting with `export`, etc.), it started a private MongoDB in `./.mongo-data` and pointed the app at it.
   Everything was saved there, not in your database.
   → Removed. `.env` files are now read with Next.js's own loader, and the app and every script stop with a
   clear message when `MONGODB_URI` is missing.
2. **Wrong database name.** `MONGODB_DB` defaulted to `ind2b` and overrode the database named in your URI,
   so data went to a database called `ind2b` while you were looking at e.g. `…mongodb.net/shopdb`.
   → The name is now `MONGODB_DB`, else the one in the URI, else `ind2b`. The server prints the host and
   database it uses at start-up.
3. **Clearing a field did not save.** Mongoose drops `undefined` from updates, so removing a product's HSN
   (or its B2B tiers) left the old value in MongoDB. Same for an old plugin-rejection note.
   → Cleared fields are now removed with `$unset`.
4. **Templates and the plugin catalogue were only in code.** → New `templates` and `apps` collections,
   seeded from `src/lib/db/catalog.ts` on first use (existing plugin review decisions are carried over).
   Merchant dashboard, start wizard, template gallery, admin and super admin consoles all read them from MongoDB.
5. **Images on disk.** Files saved in `./.uploads` by older versions are now copied into MongoDB (GridFS)
   the first time they are requested. Nothing is written to disk.

## Files
New: `src/scripts/load-env.mjs`, `src/scripts/migrate-local-data.mjs`, `src/lib/services/catalog.ts`
Changed: `src/scripts/dev.mjs`, `src/scripts/reset-db.mjs`, `src/scripts/create-superadmin.mjs`, `src/lib/config/env.ts`,
`src/lib/db/connect.ts`, `src/lib/db/models/index.ts`, `src/lib/services/index.ts`, `src/lib/services/platform.ts`,
`src/lib/media/storage.ts`, `src/actions/{dashboard,superadmin-portal,superadmin,admin}.ts`,
`src/app/{admin,superadmin}/…/templates/page.tsx`, `src/app/dashboard/(shell)/online-store/page.tsx`,
`src/app/superadmin/(portal)/stores/[id]/page.tsx`, `src/docs/AUTH.md`, `src/docs/DATABASE.md`
Everything else is unchanged.

## After copying the files
1. `.env.local` must contain your connection string, e.g.
   `MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/ind2b?retryWrites=true&w=majority`
   (optional: `SEED_DEMO_DATA=false` if you don't want demo stores in an empty database).
2. Update the `"scripts"` paths in `package.json` (see "Installing" at the end).
3. If you have `./.mongo-data` or `./.uploads` from before, run `npm run db:migrate-local -- --dry-run`,
   then `npm run db:migrate-local` (stop `npm run dev` first).
4. `npm run dev` and check the first lines: `▸ MongoDB: … database "…"` and
   `[ind2b] Connected to MongoDB …, database "…"`.

# Folder restructure (everything inside src/)

`scripts/` → `src/scripts/`, docs → `src/docs/`, and the loose files of `src/lib/` moved into folders
(see STRUCTURE.md). Only file locations and import paths changed; no function was changed.

| Before | After |
|---|---|
| src/lib/env.ts | src/lib/config/env.ts |
| src/lib/catalog.ts | src/lib/db/catalog.ts |
| src/lib/types.ts | src/lib/types/index.ts (still imported as `@/lib/types`) |
| src/lib/merchant.ts, admin.ts, superadmin.ts | src/lib/portals/merchant.ts, admin.ts, superadmin.ts |
| src/lib/security.ts, audit.ts | src/lib/security/index.ts (still `@/lib/security`), src/lib/security/audit.ts |
| src/lib/storefront.ts, pricing.ts, demo.ts | src/lib/storefront/index.ts (still `@/lib/storefront`), pricing.ts, demo.ts |
| src/lib/kyc.ts | src/lib/media/kyc.ts |
| src/lib/cn.ts, format.ts, version-key.ts | src/lib/utils/… |
| scripts/*.mjs, mongo-init.js | src/scripts/… |

## Installing
1. Delete your old `src/` folder and the top-level `scripts/` folder, then put the new `src/` in their place
   (copying over the old `src/` would leave the old loose files behind as duplicates).
2. Replace the `"scripts"` paths in `package.json` (keep any other scripts you have, e.g. build/start/lint):
```json
"dev": "node src/scripts/dev.mjs",
"db:reset": "node src/scripts/reset-db.mjs",
"db:migrate-local": "node src/scripts/migrate-local-data.mjs",
"superadmin": "node src/scripts/create-superadmin.mjs",
"email:test": "node src/scripts/test-email.mjs"
```
3. If you use Docker, change the init script path in `docker-compose.yml`:
   `./scripts/mongo-init.js` → `./src/scripts/mongo-init.js`.
4. `tsconfig.json` needs no change (`"@/*": ["./src/*"]`).

# Ready-to-run project (root files added)

- Root files: `package.json` (all dependencies and npm scripts), `tsconfig.json`, `next.config.mjs`,
  `postcss.config.mjs`, `.env.example`, `.gitignore`, `.nvmrc`, `README.md`, `Dockerfile`, `.dockerignore`,
  `docker-compose.yml`. Install with `npm install`, run with `npm run dev`.
- `src/proxy.ts`: the main site now also answers on the host of `APP_URL` and on Vercel's own deployment
  addresses, so a new deployment no longer shows "Not found" on every page.
- `src/scripts/test-email.mjs`: reads `.env.local` with the shared loader (same parser as Next.js).
- Sessions filters typed for Mongoose 9 (`src/lib/services/sessions.ts`, `platform.ts`).
