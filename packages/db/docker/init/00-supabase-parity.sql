-- Runs once, as the container superuser, when the local volume is created.
-- It reproduces the parts of Supabase that the product must survive (measured on the live project, 2026-10-22):
--   * the operator role (`postgres` on Supabase) is NOT superuser but has CREATEROLE, CREATEDB and BYPASSRLS
--     and owns the database; here it is `platform_admin`, and every bootstrap/test step uses it, never `postgres`;
--   * the Data API roles exist, and objects the operator creates in `public` are granted to them by default.
-- Product objects must therefore be owned by `migrator` and live outside `public`; the integration suite asserts it.
CREATE ROLE platform_admin LOGIN NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS;
CREATE DATABASE platform OWNER platform_admin;
CREATE DATABASE platform_shadow OWNER platform_admin; -- Prisma drift check (`db:drift`)

CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

\connect platform
ALTER SCHEMA public OWNER TO pg_database_owner;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE platform_admin IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE platform_admin IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
