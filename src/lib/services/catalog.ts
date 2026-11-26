import "server-only";
import { APPS as DEFAULT_APPS, TEMPLATES as DEFAULT_TEMPLATES } from "../db/catalog";
import { connectDb } from "../db/connect";
import { AppModel, AppReviewModel, TemplateModel, type AppDoc, type TemplateDoc } from "../db/models";
import type { AppDef, Section, StoreCategory, Template, Theme, ThemeTokens } from "../types";

/**
 * Store templates and the plugin catalogue, stored in MongoDB (collections "templates" and "apps").
 *
 * src/lib/db/catalog.ts only provides the defaults: on first use every template / plugin that is not in
 * the database yet is inserted ($setOnInsert, so saved changes are never overwritten). From then on
 * every page, console and Server Action reads them from MongoDB.
 */

/* ================================================================ templates */
const toTemplate = (d: Pick<TemplateDoc, "_id" | "name" | "tagline" | "bestFor" | "free" | "tokens" | "sections">): Template => ({
  id: d._id, name: d.name, tagline: d.tagline ?? "", bestFor: (d.bestFor ?? []) as StoreCategory[], free: d.free !== false,
  tokens: d.tokens as ThemeTokens, sections: (d.sections ?? []) as Section[],
});

async function ensureTemplates() {
  await connectDb();
  const have = new Set((await TemplateModel.find({}, { _id: 1 }).lean()).map((t) => t._id));
  const missing = DEFAULT_TEMPLATES.map((t, i) => ({ t, i })).filter(({ t }) => !have.has(t.id));
  if (!missing.length) return;
  const now = new Date();
  await Promise.all(missing.map(({ t, i }) => TemplateModel.updateOne({ _id: t.id }, {
    $setOnInsert: {
      name: t.name, tagline: t.tagline, bestFor: t.bestFor, free: t.free, tokens: { ...t.tokens }, sections: structuredClone(t.sections),
      order: i, active: true, createdAt: now, updatedAt: now,
    },
  }, { upsert: true })));
}

/** Templates shown in the gallery, the start wizard and the dashboard (active ones, in catalogue order). */
export async function listTemplates(opts: { includeInactive?: boolean } = {}): Promise<Template[]> {   // GET /themes/templates
  await ensureTemplates();
  const rows = await TemplateModel.find(opts.includeInactive ? {} : { active: { $ne: false } }).sort({ order: 1, _id: 1 }).lean();
  return rows.map(toTemplate);
}

export async function getTemplate(id: string): Promise<Template | undefined> {
  await ensureTemplates();
  const r = await TemplateModel.findById(String(id)).lean();
  return r ? toTemplate(r) : undefined;
}

/** A fresh theme copied from a template (the store keeps its own copy). Unknown ids fall back to the first template. */
export async function themeFromTemplate(templateId: string, version = 1): Promise<Theme> {
  const t = (await getTemplate(templateId)) ?? (await listTemplates())[0];
  if (!t) throw new Error("no_templates");
  // A plain JSON copy: the store's theme must never share objects with the template document.
  return { templateId: t.id, version, tokens: JSON.parse(JSON.stringify(t.tokens)), sections: JSON.parse(JSON.stringify(t.sections)) };
}

/* ================================================================ plugins */
const toApp = (d: AppDoc): AppDef => ({
  id: d._id, name: d.name, developer: d.developer ?? "", category: d.category as AppDef["category"], summary: d.summary ?? "",
  description: d.description ?? "", pricing: d.pricing ?? "", rating: d.rating ?? 0, installs: d.installs ?? 0, builtIn: !!d.builtIn,
  extensions: (d.extensions ?? []) as AppDef["extensions"], ...(d.sections?.length ? { sections: d.sections as AppDef["sections"] } : {}),
  status: d.status,
});

async function ensureApps() {
  await connectDb();
  const have = new Set((await AppModel.find({}, { _id: 1 }).lean()).map((a) => a._id));
  const missing = DEFAULT_APPS.map((a, i) => ({ a, i })).filter(({ a }) => !have.has(a.id));
  if (!missing.length) return;
  // Review decisions made before plugins were stored in MongoDB are kept.
  const reviews = new Map((await AppReviewModel.find({ _id: { $in: missing.map(({ a }) => a.id) } }).lean()).map((r) => [r._id, r.status]));
  const now = new Date();
  await Promise.all(missing.map(({ a, i }) => AppModel.updateOne({ _id: a.id }, {
    $setOnInsert: {
      name: a.name, developer: a.developer, category: a.category, summary: a.summary, description: a.description, pricing: a.pricing,
      rating: a.rating, installs: a.installs, builtIn: a.builtIn, extensions: a.extensions, sections: a.sections ?? [],
      status: (reviews.get(a.id) as AppDef["status"] | undefined) ?? a.status, order: i, createdAt: now, updatedAt: now,
    },
  }, { upsert: true })));
}

/** Every plugin with its current listing status, from MongoDB. */
export async function listAllApps(): Promise<AppDef[]> {
  await ensureApps();
  return (await AppModel.find({}).sort({ order: 1, _id: 1 }).lean()).map(toApp);
}

export async function findApp(id: string): Promise<AppDef | undefined> {
  await ensureApps();
  const r = await AppModel.findById(String(id)).lean();
  return r ? toApp(r) : undefined;
}

export async function isKnownApp(id: string) {
  return !!(await findApp(id));
}

/** Records a review decision: the plugin's status in "apps" and the decision note in "appreviews". */
export async function setAppStatus(appId: string, status: AppDef["status"], note?: string) {               // POST /apps/{id}/review
  await ensureApps();
  const now = new Date();
  const res = await AppModel.updateOne({ _id: String(appId) }, { $set: { status, updatedAt: now } });
  if (res.matchedCount === 0) throw new Error("unknown_app");
  await AppReviewModel.updateOne({ _id: String(appId) }, note ? { $set: { status, note, updatedAt: now } } : { $set: { status, updatedAt: now }, $unset: { note: 1 } }, { upsert: true });
}
