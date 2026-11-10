import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";

// Prisma is the schema's source of truth and generates the SQL migrations. The app
// applies those migrations itself, to PostgreSQL in the browser (PGlite), and never
// connects to a database server. Nothing in this file is needed to run, test or build
// the app; it only configures the Prisma CLI.
//
// The Prisma CLI reads no env file by itself. .env.example tells people to copy it to
// .env.local, the file Next.js reads, so the CLI reads that same file here. A variable
// that is already set in the shell wins over the file.
const envFile = fileURLToPath(new URL(".env.local", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    // Only matters when the schema is moved to a server-side PostgreSQL: this is where
    // `prisma migrate deploy` applies the migrations.
    url: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/claude_lifetime",
    // `npm run db:migration` compares the migrations with the schema. To learn what the
    // migrations add up to, Prisma replays them in this scratch ("shadow") database and
    // erases whatever is in it. So there is no default, and DATABASE_URL never stands in
    // for it: the command must not be able to empty a database nobody named for that.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL || undefined,
  },
});
