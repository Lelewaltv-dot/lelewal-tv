import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";

// Articles d'actualité publiés depuis l'espace administrateur.
export const articles = pgTable(
  "articles",
  {
    id: serial().primaryKey(),
    title: text().notNull(),
    excerpt: text().notNull().default(""),
    body: text().notNull().default(""),
    // senegal | fouta | societe | sport | culture
    category: text().notNull(),
    // published | draft
    status: text().notNull().default("published"),
    imageKey: text("image_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    index("articles_status_published_idx").on(t.status, t.publishedAt),
    index("articles_category_idx").on(t.category),
  ],
);

// Suivi des tentatives de connexion échouées (protection contre la force brute).
export const loginAttempts = pgTable("login_attempts", {
  ip: text().primaryKey(),
  failures: integer().notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
});
