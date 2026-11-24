import { Hono, type Context as HonoContext, type Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { getContext } from "@netlify/server";
import { getStore } from "@netlify/blobs";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../db/index.js";
import { articles } from "../../db/schema.js";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  adminUsername,
  checkCredentials,
  clearFailures,
  createSessionToken,
  isAuthConfigured,
  isLocked,
  recordFailure,
  verifySessionToken,
} from "./auth.js";

export const config = {
  path: ["/api/*", "/media/*"],
};

const CATEGORIES = ["senegal", "fouta", "societe", "sport", "culture"] as const;
const STATUSES = ["published", "draft"] as const;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const images = () => getStore({ name: "article-images", consistency: "strong" });

type Article = typeof articles.$inferSelect;

function serialize(a: Article, withBody = true) {
  return {
    id: a.id,
    title: a.title,
    excerpt: a.excerpt,
    ...(withBody ? { body: a.body } : {}),
    category: a.category,
    status: a.status,
    imageUrl: a.imageKey ? `/media/${a.imageKey}` : null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    publishedAt: a.publishedAt,
  };
}

function clientIp(c: HonoContext): string {
  try {
    const ip = getContext().ip;
    if (ip) return ip;
  } catch {}
  return c.req.header("x-nf-client-connection-ip") || c.req.header("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

function isHttps(c: HonoContext): boolean {
  const url = new URL(c.req.url);
  return url.protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
}

// ---- Image validation (magic bytes) ----
function detectImage(bytes: Uint8Array): { ext: string; type: string } | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return { ext: "png", type: "image/png" };
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return { ext: "gif", type: "image/gif" };
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return { ext: "webp", type: "image/webp" };
  return null;
}

class ValidationError extends Error {}

async function saveImage(file: File): Promise<string> {
  if (file.size > MAX_IMAGE_BYTES) throw new ValidationError("La photo est trop lourde (8 Mo maximum).");
  const buffer = new Uint8Array(await file.arrayBuffer());
  const kind = detectImage(buffer);
  if (!kind) throw new ValidationError("Format de photo non pris en charge (JPEG, PNG, WebP ou GIF).");
  const key = `${randomUUID()}.${kind.ext}`;
  await images().set(key, buffer.buffer as ArrayBuffer, { metadata: { contentType: kind.type } });
  return key;
}

async function removeImage(key: string | null) {
  if (!key) return;
  try {
    await images().delete(key);
  } catch (err) {
    console.error("Failed to delete image", key, err);
  }
}

function makeExcerpt(body: string): string {
  const plain = body.replace(/\s+/g, " ").trim();
  if (plain.length <= 180) return plain;
  return plain.slice(0, 177).replace(/\s+\S*$/, "") + "…";
}

type ParsedFields = {
  title: string;
  excerpt: string;
  body: string;
  category: string;
  status: string;
  image: File | null;
  removeImage: boolean;
};

async function parseArticleForm(c: HonoContext): Promise<ParsedFields> {
  const form = await c.req.parseBody();
  const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "").trim();
  const title = str("title");
  const body = str("body").replace(/\r\n/g, "\n");
  let excerpt = str("excerpt");
  const category = str("category");
  const status = str("status") || "published";
  const image = form.image instanceof File && form.image.size > 0 ? form.image : null;

  if (!title) throw new ValidationError("Le titre est obligatoire.");
  if (title.length > 200) throw new ValidationError("Le titre ne doit pas dépasser 200 caractères.");
  if (!body) throw new ValidationError("Le texte de l'article est obligatoire.");
  if (body.length > 60000) throw new ValidationError("Le texte est trop long.");
  if (excerpt.length > 400) throw new ValidationError("Le résumé ne doit pas dépasser 400 caractères.");
  if (!(CATEGORIES as readonly string[]).includes(category)) throw new ValidationError("Choisissez une rubrique valide.");
  if (!(STATUSES as readonly string[]).includes(status)) throw new ValidationError("Statut invalide.");
  if (!excerpt) excerpt = makeExcerpt(body);

  return { title, excerpt, body, category, status, image, removeImage: str("removeImage") === "1" };
}

function parseId(raw: string): number | null {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
  console.error(err);
  return c.json({ error: "Une erreur interne est survenue. Veuillez réessayer." }, 500);
});

// ---------------- Public API ----------------

app.get("/api/articles", async (c) => {
  const category = c.req.query("category");
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 30, 1), 100);
  const conditions = [eq(articles.status, "published")];
  if (category) {
    if (!(CATEGORIES as readonly string[]).includes(category)) return c.json({ articles: [] });
    conditions.push(eq(articles.category, category));
  }
  const rows = await db
    .select()
    .from(articles)
    .where(and(...conditions))
    .orderBy(desc(articles.publishedAt), desc(articles.id))
    .limit(limit);
  c.header("Cache-Control", "public, max-age=0, must-revalidate");
  return c.json({ articles: rows.map((a) => serialize(a, false)) });
});

app.get("/api/articles/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Article introuvable." }, 404);
  const [row] = await db
    .select()
    .from(articles)
    .where(and(eq(articles.id, id), eq(articles.status, "published")));
  if (!row) return c.json({ error: "Article introuvable." }, 404);
  return c.json({ article: serialize(row) });
});

app.get("/media/:key", async (c) => {
  const key = c.req.param("key");
  if (!/^[0-9a-f-]{36}\.(jpg|png|gif|webp)$/.test(key)) return c.notFound();
  const result = await images().getWithMetadata(key, { type: "stream" });
  if (!result) return c.notFound();
  const contentType = (result.metadata?.contentType as string) || "application/octet-stream";
  return new Response(result.data as ReadableStream, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

// ---------------- Admin API ----------------

// Reject cross-site state-changing requests (defence in depth on top of SameSite cookies).
app.use("/api/admin/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    const host = c.req.header("x-forwarded-host") || c.req.header("host");
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {}
      if (!host || originHost !== host) return c.json({ error: "Requête refusée." }, 403);
    }
  }
  await next();
});

async function requireAdmin(c: HonoContext, next: Next) {
  const user = verifySessionToken(getCookie(c, SESSION_COOKIE));
  if (!user) return c.json({ error: "Session expirée. Veuillez vous reconnecter." }, 401);
  await next();
}

app.get("/api/admin/session", (c) => {
  const user = verifySessionToken(getCookie(c, SESSION_COOKIE));
  return c.json({ authenticated: Boolean(user), username: user, configured: isAuthConfigured() });
});

app.post("/api/admin/login", async (c) => {
  if (!isAuthConfigured()) {
    return c.json({ error: "L'espace administrateur n'est pas encore configuré." }, 503);
  }
  const ip = clientIp(c);
  const lockedFor = await isLocked(ip);
  if (lockedFor > 0) {
    return c.json(
      { error: `Trop de tentatives. Réessayez dans ${lockedFor} minute${lockedFor > 1 ? "s" : ""}.` },
      429,
    );
  }
  let username = "";
  let password = "";
  try {
    const data = await c.req.json();
    username = typeof data.username === "string" ? data.username : "";
    password = typeof data.password === "string" ? data.password : "";
  } catch {
    return c.json({ error: "Requête invalide." }, 400);
  }
  if (!checkCredentials(username, password)) {
    await recordFailure(ip);
    return c.json({ error: "Identifiant ou mot de passe incorrect." }, 401);
  }
  await clearFailures(ip);
  setCookie(c, SESSION_COOKIE, createSessionToken(), {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return c.json({ ok: true, username: adminUsername() });
});

app.post("/api/admin/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isHttps(c) });
  return c.json({ ok: true });
});

app.use("/api/admin/articles", requireAdmin);
app.use("/api/admin/articles/*", requireAdmin);
app.use("/api/admin/stats", requireAdmin);

app.get("/api/admin/stats", async (c) => {
  const rows = await db
    .select({ category: articles.category, status: articles.status, count: sql<number>`count(*)::int` })
    .from(articles)
    .groupBy(articles.category, articles.status);
  return c.json({ stats: rows });
});

app.get("/api/admin/articles", async (c) => {
  const rows = await db.select().from(articles).orderBy(desc(articles.createdAt), desc(articles.id));
  return c.json({ articles: rows.map((a) => serialize(a, false)) });
});

app.get("/api/admin/articles/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Article introuvable." }, 404);
  const [row] = await db.select().from(articles).where(eq(articles.id, id));
  if (!row) return c.json({ error: "Article introuvable." }, 404);
  return c.json({ article: serialize(row) });
});

app.post("/api/admin/articles", async (c) => {
  const f = await parseArticleForm(c);
  const imageKey = f.image ? await saveImage(f.image) : null;
  const now = new Date();
  const [row] = await db
    .insert(articles)
    .values({
      title: f.title,
      excerpt: f.excerpt,
      body: f.body,
      category: f.category,
      status: f.status,
      imageKey,
      createdAt: now,
      updatedAt: now,
      publishedAt: f.status === "published" ? now : null,
    })
    .returning();
  return c.json({ article: serialize(row) }, 201);
});

app.put("/api/admin/articles/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Article introuvable." }, 404);
  const [existing] = await db.select().from(articles).where(eq(articles.id, id));
  if (!existing) return c.json({ error: "Article introuvable." }, 404);

  const f = await parseArticleForm(c);
  let imageKey = existing.imageKey;
  let oldKeyToDelete: string | null = null;
  if (f.image) {
    imageKey = await saveImage(f.image);
    oldKeyToDelete = existing.imageKey;
  } else if (f.removeImage) {
    imageKey = null;
    oldKeyToDelete = existing.imageKey;
  }

  const now = new Date();
  const [row] = await db
    .update(articles)
    .set({
      title: f.title,
      excerpt: f.excerpt,
      body: f.body,
      category: f.category,
      status: f.status,
      imageKey,
      updatedAt: now,
      publishedAt: f.status === "published" ? (existing.publishedAt ?? now) : existing.publishedAt,
    })
    .where(eq(articles.id, id))
    .returning();
  await removeImage(oldKeyToDelete);
  return c.json({ article: serialize(row) });
});

app.delete("/api/admin/articles/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Article introuvable." }, 404);
  const [row] = await db.delete(articles).where(eq(articles.id, id)).returning();
  if (!row) return c.json({ error: "Article introuvable." }, 404);
  await removeImage(row.imageKey);
  return c.json({ ok: true });
});

app.notFound((c) => c.json({ error: "Introuvable." }, 404));

export default app;
