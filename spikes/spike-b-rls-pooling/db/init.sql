-- Spike B schema. Mirrors the SRS 5.3 isolation pattern on a deliberately tiny model.
-- Roles: migrator (owns tables) | app_user (RLS applies) | app_public (only SECURITY DEFINER fns)
--        svc_definer (NOLOGIN, NOBYPASSRLS, owns the SECURITY DEFINER functions; gets explicit narrow policies)
-- NOTE: no role here needs BYPASSRLS or SUPERUSER. Managed Postgres (Supabase, RDS, ...) does not hand out superuser,
-- so the design must not depend on it.
CREATE ROLE migrator LOGIN PASSWORD 'migrator_pw';
CREATE ROLE app_user LOGIN PASSWORD 'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE app_public LOGIN PASSWORD 'public_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE svc_definer NOLOGIN NOBYPASSRLS;
-- migrator must be a member of svc_definer to hand it function ownership. INHERIT FALSE is essential: with the default
-- INHERIT TRUE, migrator would also inherit svc_definer's RLS policies and could read every tenant's rows
-- (found by Spike B: owner-with-no-context saw 5 project rows).
GRANT svc_definer TO migrator WITH INHERIT FALSE, SET TRUE;

ALTER SCHEMA public OWNER TO migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_user, app_public, svc_definer;

SET ROLE migrator;

CREATE TABLE workspace (
  id   uuid PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE project (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace (id),
  name         text NOT NULL,
  UNIQUE (workspace_id, id)              -- target of the composite FKs below
);

CREATE TABLE lead (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id   uuid NOT NULL,
  name         text NOT NULL,
  FOREIGN KEY (workspace_id, project_id) REFERENCES project (workspace_id, id)
);

CREATE TABLE domain (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id   uuid NOT NULL,
  hostname     text NOT NULL UNIQUE,
  FOREIGN KEY (workspace_id, project_id) REFERENCES project (workspace_id, id)
);

-- Current-tenant accessor. NULLIF matters: after a transaction-local set_config, a pooled
-- connection reports '' (not NULL) for the GUC, and ''::uuid raises an error.
CREATE FUNCTION current_workspace() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION current_workspace() TO app_user;

-- RLS: enabled AND forced on every tenant table.
ALTER TABLE workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace FOR ALL TO app_user
  USING (id = current_workspace()) WITH CHECK (id = current_workspace());

ALTER TABLE project ENABLE ROW LEVEL SECURITY;
ALTER TABLE project FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project FOR ALL TO app_user
  USING (workspace_id = current_workspace()) WITH CHECK (workspace_id = current_workspace());

ALTER TABLE lead ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead FOR ALL TO app_user
  USING (workspace_id = current_workspace()) WITH CHECK (workspace_id = current_workspace());

ALTER TABLE domain ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON domain FOR ALL TO app_user
  USING (workspace_id = current_workspace()) WITH CHECK (workspace_id = current_workspace());

GRANT SELECT, INSERT, UPDATE, DELETE ON workspace, project, lead, domain TO app_user;
-- app_public gets NO table privileges at all; it can only execute the functions below.
GRANT SELECT ON domain, project TO svc_definer;
GRANT INSERT ON lead TO svc_definer;
-- INSERT ... RETURNING also needs SELECT on the returned column. Grant only that column (least privilege).
GRANT SELECT (id) ON lead TO svc_definer;

-- svc_definer is subject to RLS like everyone else (FORCE RLS), so the functions below work only because of these
-- explicit, narrow policies. Each one is visible in pg_policies and can be reviewed/tested individually.
CREATE POLICY definer_read ON domain  FOR SELECT TO svc_definer USING (true);
CREATE POLICY definer_read ON project FOR SELECT TO svc_definer USING (true);
CREATE POLICY definer_insert ON lead  FOR INSERT TO svc_definer WITH CHECK (true);
CREATE POLICY definer_returning ON lead FOR SELECT TO svc_definer USING (true); -- needed for INSERT ... RETURNING id

-- Public read path (visitor -> which site?). SECURITY DEFINER runs as svc_definer (BYPASSRLS),
-- so it needs no tenant context, but it can only ever do exactly what the function body says.
CREATE FUNCTION resolve_host(p_host text)
RETURNS TABLE (workspace_id uuid, project_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT d.workspace_id, d.project_id FROM domain d WHERE d.hostname = p_host $$;

-- Public write path (visitor submits a lead). workspace_id is DERIVED from the project, never accepted.
CREATE FUNCTION insert_lead(p_project uuid, p_name text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS
$$ INSERT INTO lead (workspace_id, project_id, name)
   SELECT workspace_id, id, p_name FROM project WHERE id = p_project
   RETURNING id $$;

-- Postgres requires the NEW owner to hold CREATE on the schema while ownership is transferred.
-- Grant it only for these two statements, then revoke: svc_definer must not be able to create objects.
GRANT CREATE ON SCHEMA public TO svc_definer;
ALTER FUNCTION resolve_host(text) OWNER TO svc_definer;
ALTER FUNCTION insert_lead(uuid, text) OWNER TO svc_definer;
REVOKE CREATE ON SCHEMA public FROM svc_definer;
REVOKE ALL ON FUNCTION resolve_host(text), insert_lead(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_host(text), insert_lead(uuid, text) TO app_public;

RESET ROLE;
