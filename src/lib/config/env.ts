import "server-only";
import { z } from "zod";

/**
 * Server configuration, validated once on first use. In production the app
 * refuses to run with a missing or weak secret or without a database URL,
 * instead of silently falling back to unsafe defaults.
 */
const isProd = process.env.NODE_ENV === "production";

/** Cloudinary's own connection string: cloudinary://<api_key>:<api_secret>@<cloud_name> */
const CLOUDINARY_URL_RE = /^cloudinary:\/\/(\d+):([^@\s]+)@([a-z0-9_-]+)$/i;

const schema = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, "MONGODB_URI must start with mongodb:// or mongodb+srv://"),
  /**
   * Database name. Optional: when not set, the name in MONGODB_URI is used
   * (mongodb+srv://…mongodb.net/<name>?…), and "ind2b" only when the URI has none.
   * (Earlier versions always used "ind2b", ignoring the name in the URI, so data landed
   * in a different database than the one you were looking at.)
   */
  MONGODB_DB: z.string().regex(/^[A-Za-z0-9_-]{1,38}$/, "MONGODB_DB may only contain letters, digits, _ and -").optional(),
  SESSION_SECRET: isProd
    ? z.string().min(32, "SESSION_SECRET must be at least 32 characters in production")
    : z.string().optional(),
  SEED_DEMO_DATA: z.enum(["true", "false"]).default(isProd ? "false" : "true"),
  CLOUDINARY_URL: z.string().regex(CLOUDINARY_URL_RE, "CLOUDINARY_URL must look like cloudinary://<api_key>:<api_secret>@<cloud_name>").optional(),
  CLOUDINARY_CLOUD_NAME: z.string().regex(/^[a-z0-9_-]+$/i).optional(),
  CLOUDINARY_API_KEY: z.string().regex(/^\d+$/).optional(),
  CLOUDINARY_API_SECRET: z.string().min(10).optional(),
  CLOUDINARY_FOLDER: z.string().regex(/^[a-z0-9_/-]+$/i).default("ind2b"),
  /** Only read by `npm run db:migrate-local` (images saved on disk by older versions). Nothing is written there any more. */
  UPLOAD_DIR: z.string().default(".uploads"),
  /**
   * Outgoing email (sign-up codes, password resets).
   *   gmail   — Gmail / Google Workspace over SMTP with an App Password (EMAIL_USER + EMAIL_APP_PASSWORD)
   *   smtp    — any SMTP server (SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_APP_PASSWORD)
   *   console — development only: emails are printed in the server log instead of being sent
   * Unset: "console" in development; in production emails cannot be sent (sign-up and resets show an error).
   */
  EMAIL_PROVIDER: z.enum(["gmail", "smtp", "console"]).optional(),
  EMAIL_USER: z.string().trim().email("EMAIL_USER must be the email address that sends mail").optional(),
  EMAIL_APP_PASSWORD: z.string().optional(),
  EMAIL_FROM_NAME: z.string().trim().max(60).default("IND2B"),
  EMAIL_REPLY_TO: z.string().trim().email().optional(),
  SMTP_HOST: z.string().trim().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  /** Kept for compatibility (no longer required): without Cloudinary, images are stored in MongoDB. */
  ALLOW_LOCAL_UPLOADS: z.enum(["true", "false"]).default("false"),
})
  // CLOUDINARY_URL fills in the three separate variables (explicit variables win); the database name comes from MONGODB_DB or the URI.
  .transform((v) => {
    const m = v.CLOUDINARY_URL ? CLOUDINARY_URL_RE.exec(v.CLOUDINARY_URL) : null;
    const withDb = { ...v, MONGODB_DB: databaseName(v.MONGODB_URI, v.MONGODB_DB) };
    return m ? { ...withDb, CLOUDINARY_API_KEY: v.CLOUDINARY_API_KEY ?? m[1], CLOUDINARY_API_SECRET: v.CLOUDINARY_API_SECRET ?? m[2], CLOUDINARY_CLOUD_NAME: v.CLOUDINARY_CLOUD_NAME ?? m[3] } : withDb;
  })
  .superRefine((v, ctx) => {
    const c = [v.CLOUDINARY_CLOUD_NAME, v.CLOUDINARY_API_KEY, v.CLOUDINARY_API_SECRET].filter(Boolean).length;
    if (c !== 0 && c !== 3) ctx.addIssue({ code: "custom", message: "Set CLOUDINARY_URL, or all three CLOUDINARY_* variables, or none" });
    if ((v.EMAIL_PROVIDER === "gmail" || v.EMAIL_PROVIDER === "smtp") && (!v.EMAIL_USER || !v.EMAIL_APP_PASSWORD)) {
      ctx.addIssue({ code: "custom", path: ["EMAIL_USER"], message: `EMAIL_PROVIDER=${v.EMAIL_PROVIDER} needs EMAIL_USER and EMAIL_APP_PASSWORD` });
    }
    if (v.EMAIL_PROVIDER === "smtp" && !v.SMTP_HOST) ctx.addIssue({ code: "custom", path: ["SMTP_HOST"], message: "EMAIL_PROVIDER=smtp needs SMTP_HOST" });
    if (isProd && v.EMAIL_PROVIDER === "console") ctx.addIssue({ code: "custom", path: ["EMAIL_PROVIDER"], message: "EMAIL_PROVIDER=console is for development only" });
    // Without Cloudinary, images are stored in MongoDB (GridFS), so production no longer needs a persistent disk.
  });

/** MONGODB_DB, else the database named in the URI path, else "ind2b" (same rule as src/scripts/load-env.mjs). */
export function databaseName(uri: string, explicit?: string) {
  if (explicit?.trim()) return explicit.trim();
  const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]*\/([^?]+)/.exec(uri);
  let fromUri = "";
  try { fromUri = m?.[1] ? decodeURIComponent(m[1]).trim() : ""; } catch { fromUri = ""; }
  return /^[A-Za-z0-9_-]{1,38}$/.test(fromUri) ? fromUri : "ind2b";
}

export type Env = z.infer<typeof schema>;
let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const raw = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, v === "" ? undefined : v?.replace(/^\uFEFF/, "")]));
  if (!raw.MONGODB_URI) {
    throw new Error(
      "MONGODB_URI is not set. IND2B stores all data in MongoDB only: add your connection string to .env.local, e.g.\n" +
      "  MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/ind2b?retryWrites=true&w=majority",
    );
  }
  raw.MONGODB_URI = raw.MONGODB_URI.trim();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "config"}: ${i.message}`).join("\n");
    throw new Error(`Invalid server configuration:\n${msg}\nSee .env.example.`);
  }
  cached = parsed.data;
  return cached;
}

export const mediaProvider = () => (env().CLOUDINARY_CLOUD_NAME ? "cloudinary" : "mongodb") as "cloudinary" | "mongodb";
