import { defineConfig } from 'prisma/config';

// Direct connection (bypasses the pooler) is what the Prisma CLI should use (per Prisma docs).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DIRECT_URL ?? 'postgresql://migrator:migrator_pw@localhost:55432/spike',
  },
});
