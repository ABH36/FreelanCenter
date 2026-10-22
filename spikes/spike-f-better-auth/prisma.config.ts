import { defineConfig } from 'prisma/config';

// Only `prisma generate` runs here; the schema itself is created by db/init.sql (roles, grants, RLS).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DIRECT_URL ?? 'postgresql://migrator:migrator_pw@localhost:55433/spike_f',
  },
});
