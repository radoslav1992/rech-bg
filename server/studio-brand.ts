import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ContextVars, Env } from "./types";
import { now, uid } from "./types";
import { rate } from "./security";
import { loadProjectDoc, ownedMedia } from "./studio-projects";
import { brandKitSchema, defaultBrandKit, MAX_TEMPLATES, type BrandKit } from "../shared/brand";
import { imageAssetKinds, videoAssetKinds } from "../shared/layers";
import { projectDocSchema, type ProjectDoc } from "../shared/project";

// Brand kit (one per account) and project templates for the video studio.
export const studioBrand = new Hono<{ Bindings: Env; Variables: ContextVars }>();
const unavailable = () => new HTTPException(400, { message: "Бранд комплектът съдържа файл, който не е наличен." });

export async function loadBrandKit(e: Env, userId: string): Promise<BrandKit> {
  const row = await e.DB.prepare("SELECT kit FROM brand_kits WHERE user_id=?").bind(userId).first<{ kit: string }>();
  const parsed = row ? brandKitSchema.safeParse(JSON.parse(row.kit)) : null;
  return parsed?.success ? parsed.data : defaultBrandKit();
}
studioBrand.get("/brand", async (c) => c.json({ kit: await loadBrandKit(c.env, c.get("user").id) }));
studioBrand.put("/brand", async (c) => {
  const user = c.get("user").id;
  await rate(c, "brand-kit", 300, 3600, user);
  const kit = brandKitSchema.parse(await c.req.json());
  const previous = await loadBrandKit(c.env, user);
  // Only files new to the kit are checked, so a saved kit stays editable after a file expires.
  // Keyed by use: an intro clip reused as the logo must still pass the image check.
  const known = new Set([
    previous.logo && `logo:${previous.logo.assetId}`,
    ...[previous.intro, previous.outro].map((b) => b && `bumper:${b.assetId}`),
  ].filter(Boolean));
  if (kit.logo && !known.has(`logo:${kit.logo.assetId}`) && !(await ownedMedia(c.env, user, kit.logo.assetId, imageAssetKinds, ["ready"])))
    throw unavailable();
  for (const b of [kit.intro, kit.outro])
    if (b && !known.has(`bumper:${b.assetId}`) && !(await ownedMedia(c.env, user, b.assetId, [...imageAssetKinds, ...videoAssetKinds], ["ready", "checking"])))
      throw unavailable();
  await c.env.DB.prepare("INSERT INTO brand_kits(user_id,kit,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET kit=excluded.kit,updated_at=excluded.updated_at")
    .bind(user, JSON.stringify(kit), now())
    .run();
  return c.json({ kit });
});

/** A template keeps the structure and look of a project, never its paid recordings or videos. */
export function templateOf(doc: ProjectDoc): ProjectDoc {
  return {
    ...doc,
    scenes: doc.scenes.map((s) => ({ ...s, audioJobId: null, videoJobId: null, history: [], audioFor: null })),
  };
}
studioBrand.get("/templates", async (c) => {
  const rows = (await c.env.DB.prepare("SELECT id,name,document,created_at FROM studio_templates WHERE user_id=? ORDER BY created_at DESC LIMIT ?")
    .bind(c.get("user").id, MAX_TEMPLATES)
    .all<{ id: string; name: string; document: string; created_at: number }>()).results;
  return c.json({
    templates: rows.map((t) => {
      const doc = JSON.parse(t.document) as ProjectDoc;
      return { id: t.id, name: t.name, created_at: t.created_at, scenes: doc.scenes.length, intro: !!doc.intro, outro: !!doc.outro, music: !!doc.music };
    }),
  });
});
studioBrand.post("/templates", async (c) => {
  const user = c.get("user").id;
  await rate(c, "studio-template", 60, 3600, user);
  const d = z.object({ projectId: z.uuid(), name: z.string().trim().min(1).max(80) }).parse(await c.req.json());
  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id=? AND user_id=? AND mode='studio'").bind(d.projectId, user).first();
  const stored = project && (await loadProjectDoc(c.env, user, d.projectId));
  if (!stored) throw new HTTPException(404, { message: "Проектът не е намерен или още не е запазен." });
  const count = await c.env.DB.prepare("SELECT COUNT(*) n FROM studio_templates WHERE user_id=?").bind(user).first<{ n: number }>();
  if ((count?.n || 0) >= MAX_TEMPLATES) throw new HTTPException(400, { message: `Имате ${MAX_TEMPLATES} шаблона. Изтрийте ненужните, за да добавите нов.` });
  const id = uid();
  await c.env.DB.prepare("INSERT INTO studio_templates(id,user_id,name,document,created_at) VALUES (?,?,?,?,?)")
    .bind(id, user, d.name, JSON.stringify(templateOf(stored.document)), now())
    .run();
  return c.json({ id }, 201);
});
studioBrand.delete("/templates/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM studio_templates WHERE id=? AND user_id=?").bind(c.req.param("id"), c.get("user").id).run();
  return c.json({ ok: true });
});
/** Starts a new project from a template: same scenes, scripts, voices, layers, music and look; fresh scene IDs. */
studioBrand.post("/templates/:id/use", async (c) => {
  const user = c.get("user").id;
  await rate(c, "project-create", 100, 3600, user);
  const { title } = z.object({ title: z.string().trim().min(1).max(120) }).parse(await c.req.json());
  const row = await c.env.DB.prepare("SELECT document FROM studio_templates WHERE id=? AND user_id=?").bind(c.req.param("id"), user).first<{ document: string }>();
  if (!row) throw new HTTPException(404, { message: "Шаблонът не е намерен." });
  const count = await c.env.DB.prepare("SELECT COUNT(*) n FROM projects WHERE user_id=?").bind(user).first<{ n: number }>();
  if ((count?.n || 0) >= 100) throw new HTTPException(400, { message: "Имате 100 проекта. Изтрийте ненужните, за да добавите нов." });
  const template = templateOf(projectDocSchema.parse(JSON.parse(row.document)));
  const document: ProjectDoc = { ...template, scenes: template.scenes.map((s) => ({ ...s, id: uid() })) };
  const first = document.scenes[0];
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO projects(id,user_id,title,mode,script,voice,second_voice,pause_ms,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(id, user, title, "studio", first.script, first.voice || "studio-mila", "boris", 0, now(), now()),
    c.env.DB.prepare("INSERT INTO project_documents(project_id,user_id,document,revision,updated_at) VALUES (?,?,?,1,?)")
      .bind(id, user, JSON.stringify(document), now()),
  ]);
  return c.json({ id }, 201);
});
