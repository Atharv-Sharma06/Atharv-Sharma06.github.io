import { defineConfig } from "prisma/config";

// Prisma is used as the schema source of truth and to generate SQL migrations.
// The app itself runs those migrations against PostgreSQL in the browser (PGlite),
// so no live database is needed for `prisma migrate diff`. DATABASE_URL only matters
// if you later point the same schema at a server-side PostgreSQL instance.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/claude_lifetime",
  },
});
