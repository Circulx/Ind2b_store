# Project structure

All application code, scripts and documentation live in `src/`. Only the files that Node.js and
Next.js require at the top level stay outside it: `package.json`, `package-lock.json`, `tsconfig.json`,
`next.config.*`, `postcss.config.*`, `.env*`, `docker-compose.yml`, `Dockerfile`.

```
src/
├── proxy.ts                 request routing (store subdomains), access control, security headers
│                            (Next.js requires it here)
├── app/                     routes (Next.js App Router; folder names are URLs)
│   ├── (site)/              public site: home, pricing, templates, plugins
│   ├── (auth)/              merchant login, sign-up, forgot password
│   ├── start/               create-a-store wizard
│   ├── dashboard/           merchant dashboard
│   ├── admin/               IND2B admin console
│   ├── superadmin/          super admin control centre
│   ├── store/[store]/       storefronts (shopper pages, cart, checkout, account)
│   ├── api/                 auth tokens, uploads, KYC
│   └── media/               images stored in MongoDB (GridFS)
├── actions/                 Server Actions (all form submissions / mutations), one file per area
├── components/              React components, one folder per area
│   ├── ui/  site/  auth/  dashboard/  storefront/  sections/  admin/  superadmin/
├── lib/                     server-side logic
│   ├── config/env.ts        validated environment variables (MONGODB_URI, secrets, email, Cloudinary)
│   ├── db/                  MongoDB: connect.ts, models/, bootstrap.ts (super admin), seed.ts (demo data),
│   │                        catalog.ts (DEFAULT templates, plugins and plans inserted on first use)
│   ├── services/            all data access (stores, products, orders, users, sessions, carts, plans,
│   │                        templates + plugins (catalog.ts), OTP codes, platform-wide queries)
│   ├── auth/                JWT sessions, signed-in user, shopper sessions
│   ├── portals/             guards and helpers per portal: merchant.ts, admin.ts, superadmin.ts
│   ├── security/            rate limits, same-origin checks (index.ts), audit log (audit.ts)
│   ├── storefront/          cart/store resolution (index.ts), pricing.ts, demo.ts (template previews)
│   ├── media/               image upload + storage (Cloudinary or MongoDB), kyc.ts (private KYC files)
│   ├── email/               mail provider, templates, branded OTP mails
│   ├── types/               shared TypeScript types
│   └── utils/               cn.ts, format.ts, version-key.ts
├── scripts/                 command-line tools (run through npm scripts)
│   ├── load-env.mjs         shared .env loader used by every script
│   ├── dev.mjs  reset-db.mjs  create-superadmin.mjs  test-email.mjs  migrate-local-data.mjs
│   └── mongo-init.js        creates the app's MongoDB user in Docker
└── docs/                    AUTH.md, DATABASE.md, STRUCTURE.md, CHANGES.md
```

Import paths: use `@/…` (maps to `src/…`), e.g. `import { requireStore } from "@/lib/portals/merchant"`.
