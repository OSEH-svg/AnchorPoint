import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    provider: "postgresql",
    url: process.env["DATABASE_URL"] || "postgresql://prisma:prisma_password@localhost:5432/cidb",
  },
  seed: {
    script: "ts-node prisma/seed.ts",
  },
});
