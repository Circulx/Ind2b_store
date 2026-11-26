# IND2B: one MongoDB database for everything

All portals use the single database set by `MONGODB_URI` (src/lib/db/connect.ts). The database name is
`MONGODB_DB` when set, otherwise the name in the URI (`…mongodb.net/<name>?…`), otherwise `ind2b`.
The server prints `[ind2b] Connected to MongoDB <host>, database "<name>"` once at start-up.
`MONGODB_URI` is required: the app and every script refuse to start without it (there is no local fallback any more).
Nothing is kept in server memory, on the server's disk, or in the browser except opaque ids in httpOnly cookies.

| What | Collection(s) | Written by | Read by |
|---|---|---|---|
| Merchant, admin, super admin accounts (bcrypt passwords) | `users` | /signup, /superadmin/users, npm run superadmin, SUPERADMIN_* env | every login, all consoles |
| Sign-in sessions (all portals, revocable) | `sessions` (TTL) | every login | every page/action/API (`getSession`, `getCustomerSession`) |
| Email codes (sign-up, password reset; HMAC only) | `emailotps` (TTL) | sign-up / forgot-password | code verification |
| Brute-force limits | `ratelimits` (TTL) | logins, sign-up, checkout, uploads | same |
| Stores, settings, theme, domains, plugins | `stores` | /start, dashboard, admin, super admin | storefront, all consoles |
| Products / orders / order numbers / discount codes | `products`, `orders`, `counters`, `discounts` | dashboard, checkout, super admin | storefront, dashboards |
| Shopper accounts (per store) | `customers` | store register | store login, super admin |
| **Shopping carts + applied discount code** (NEW) | `carts` (TTL 30 days) | add to cart, update cart, apply code | cart, checkout, header count; follows a signed-in shopper across devices |
| **Plans: name, price, fee, features** (NEW) | `plans` | seeded from catalog defaults on first use; edited in /superadmin/plans | /pricing, home, merchant settings, /admin, /superadmin |
| Images: details | `media` | /api/uploads | product pages, page builder |
| **Images: bytes when Cloudinary is not set** (NEW) | GridFS `media.files` / `media.chunks` | /api/uploads | /media/... |
| KYC documents | GridFS `kycdocs.*` | dashboard KYC | /api/kyc (owner + staff) |
| **Store templates: tokens, sections, free/pro** (NEW) | `templates` | seeded from catalog defaults on first use | /templates, /start, dashboard online store, /admin, /superadmin |
| **Plugin catalogue + listing status** (NEW) | `apps` | seeded from catalog defaults on first use; status set by /admin/apps, /superadmin/plugins | app store, home, dashboard, consoles |
| Plugin review decision notes | `appreviews` | /admin/apps, /superadmin/plugins | consoles |
| Newsletter, quote requests | `subscribers`, `quoterequests` | storefront | dashboard |
| Audit log | `auditlogs` | every staff action and sign-in | /admin/audit, /superadmin/audit |

With `CLOUDINARY_URL` set, image files are on Cloudinary's CDN (recommended for speed) and their details stay in `media`.
Without it, image files are stored in MongoDB (GridFS). Images that older versions saved on disk are copied into
MongoDB the first time they are requested, and all at once by `npm run db:migrate-local`; nothing is written to disk.

src/lib/db/catalog.ts now only holds the DEFAULT templates, plugins and plans. They are inserted into `templates`,
`apps` and `plans` the first time they are needed (only missing entries; saved changes are never overwritten),
and every page reads them from MongoDB. A store keeps its own copy of its theme in `stores`.

## MongoDB for development
Use an Atlas cluster, or run MongoDB in Docker (bound to this computer only; data survives restarts in the `ind2b-mongo-data` volume):

```bash
docker run -d --name ind2b-mongo -p 127.0.0.1:27017:27017 -v ind2b-mongo-data:/data/db --restart unless-stopped mongo:7
# .env.local
MONGODB_URI=mongodb://127.0.0.1:27017/ind2b
```
With `SEED_DEMO_DATA=true` (the development default) an EMPTY database gets the demo accounts listed in AUTH.md. To start over: `npm run db:reset`.

## Data saved on this computer by older versions
Earlier versions of `npm run dev` started a private MongoDB in `./.mongo-data` when they could not read
`MONGODB_URI` (for example a `.env.local` saved with a byte-order mark, or a line starting with `export`), and
saved images in `./.uploads`. Copy both into your database once:

```bash
npm run db:migrate-local -- --dry-run   # shows what would be copied
npm run db:migrate-local                # copies; existing documents in your database are kept
```

Cookies only hold ids that are checked against the database: the session JWT (names a `sessions` document),
the cart id, the merchant's currently selected store, and a guest's last order id.
Earlier carts kept in cookies are moved into MongoDB automatically on the shopper's next cart change.
