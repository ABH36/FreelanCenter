-- Spike F schema (DG-05). Question: can Better Auth persist identity data through a transaction-mode pooler
-- WITHOUT weakening the SRS 5.3 tenant-isolation pattern?
--
-- Design under test:
--   * Identity tables (user/session/account/verification/two_factor/rate_limit) are GLOBAL, not tenant-owned,
--     so they carry no workspace_id. They live in their own schema `identity`.
--   * Role split instead of RLS for identity data:
--       app_auth  - the only role Better Auth uses; privileges on `identity` only, none on tenant tables.
--       app_user  - normal tenant role (RLS); NO usage on `identity` (cannot read sessions, hashes, TOTP secrets).
--   * The bridge from a session to workspaces is `membership`, a tenant table with two policies:
--       tenant_isolation (workspace context) and self_read (transaction-local actor context, SELECT only).
--   No role here is SUPERUSER or BYPASSRLS.
CREATE ROLE migrator LOGIN PASSWORD 'migrator_pw';
CREATE ROLE app_auth LOGIN PASSWORD 'auth_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE app_user LOGIN PASSWORD 'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

CREATE SCHEMA identity AUTHORIZATION migrator;
ALTER SCHEMA public OWNER TO migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA identity FROM PUBLIC;
-- citext lives with the identity tables so app_auth needs no privilege on schema public.
CREATE EXTENSION citext SCHEMA identity;
GRANT USAGE ON SCHEMA identity TO app_auth;
GRANT USAGE ON SCHEMA public TO app_user;

SET ROLE migrator;

-- ---------- identity (Better Auth core + two-factor plugin + database rate limiter) ----------
CREATE TABLE identity.users (
  id                 uuid PRIMARY KEY,
  name               text NOT NULL,
  email              identity.citext NOT NULL UNIQUE,
  email_verified     boolean NOT NULL DEFAULT false,
  image              text,
  two_factor_enabled boolean DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.sessions (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  ip_address  text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON identity.sessions (user_id);

CREATE TABLE identity.accounts (
  id                       uuid PRIMARY KEY,
  user_id                  uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  account_id               text NOT NULL,
  provider_id              text NOT NULL,
  access_token             text,
  refresh_token            text,
  id_token                 text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  password                 text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, account_id)
);
CREATE INDEX accounts_user_id_idx ON identity.accounts (user_id);

CREATE TABLE identity.verifications (
  id          uuid PRIMARY KEY,
  identifier  text NOT NULL,
  value       text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verifications_identifier_idx ON identity.verifications (identifier);

CREATE TABLE identity.two_factors (
  id                        uuid PRIMARY KEY,
  user_id                   uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  secret                    text NOT NULL,
  backup_codes              text NOT NULL,
  verified                  boolean DEFAULT false,
  failed_verification_count integer DEFAULT 0,
  locked_until              timestamptz
);
CREATE INDEX two_factors_user_id_idx ON identity.two_factors (user_id);
CREATE INDEX two_factors_secret_idx ON identity.two_factors (secret);

CREATE TABLE identity.rate_limits (
  id           uuid PRIMARY KEY,
  key          text NOT NULL UNIQUE,
  count        integer NOT NULL,
  last_request bigint NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO app_auth;

-- ---------- tenant side (SRS 5.3 pattern) ----------
CREATE FUNCTION public.current_workspace() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $$;
-- Actor context for the session -> membership bridge. Same NULLIF rule as current_workspace() (Spike B B-1).
CREATE FUNCTION public.current_actor_user() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION public.current_workspace(), public.current_actor_user() TO app_user;

CREATE TABLE public.workspace (
  id   uuid PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE public.membership (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id),
  user_id      uuid NOT NULL REFERENCES identity.users (id),
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  UNIQUE (workspace_id, user_id)
);

ALTER TABLE public.workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.workspace FOR ALL TO app_user
  USING (id = current_workspace()) WITH CHECK (id = current_workspace());

ALTER TABLE public.membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.membership FOR ALL TO app_user
  USING (workspace_id = current_workspace()) WITH CHECK (workspace_id = current_workspace());
-- A signed-in actor may list only their own memberships (workspace switcher), read-only.
CREATE POLICY self_read ON public.membership FOR SELECT TO app_user
  USING (user_id = current_actor_user());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace, public.membership TO app_user;

RESET ROLE;
