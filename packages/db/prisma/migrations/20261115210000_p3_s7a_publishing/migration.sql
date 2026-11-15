-- =====================================================================================================
-- P3 S7a: publishing (SRS FR-PUB-01, FR-PUB-02, FR-PUB-04; module 06; design approved by the Owner 2026-11-15).
-- Runs as `migrator` after 20261115180000_p3_s6_assets. Forward-only; rollback is a new migration that restores
-- the S1 resolve_host, drops the two visitor functions, the staging_links table and its trigger functions, and the
-- three site_versions columns (nothing outside this migration reads them).
--
--   site_versions   gains `assets` (the image URLs of the version, so a published site never depends on the asset
--                   library), `publish_key` (the browser's idempotency key: a retried publish returns the version it
--                   already made) and `number` (1, 2, 3 ... per project, set by the database, for the history).
--                   Rows written before S7 have no number; the table stays immutable (S1 triggers).
--   staging_links   signed, revocable links to a project's current staging version on the sites app
--                   (`/s/<token>`, approved decision 1: 14 days, revocable, audited). The row holds no secret.
--   resolve_host    a new outcome `live` with the live SiteVersion id, when the host would otherwise show the
--                   placeholder and the project has a live pointer. The sites app caches the answer per host; the
--                   dashboard invalidates it through the outbox when it moves the live pointer.
--   get_published_version(id)   app_public: the content of one LIVE version (immutable, cached by id).
--   get_staging_site(link id)   app_public: what a staging link may show now (its project's staging version).
-- =====================================================================================================

-- =============================================================== site_versions additions
ALTER TABLE "app"."site_versions"
  ADD COLUMN "assets" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "publish_key" UUID,
  ADD COLUMN "number" INTEGER;

ALTER TABLE "app"."site_versions"
  ADD CONSTRAINT "site_versions_assets_object" CHECK (jsonb_typeof(assets) = 'object'),
  ADD CONSTRAINT "site_versions_assets_size" CHECK (octet_length(assets::text) <= 262144),
  ADD CONSTRAINT "site_versions_number_positive" CHECK (number IS NULL OR number >= 1);

-- One version per publish request, one number per version of a project.
CREATE UNIQUE INDEX "site_versions_workspace_id_project_id_publish_key_key"
  ON "app"."site_versions"("workspace_id", "project_id", "publish_key");
CREATE UNIQUE INDEX "site_versions_workspace_id_project_id_number_key"
  ON "app"."site_versions"("workspace_id", "project_id", "number");

-- The number is the database's: one more than the project's highest. The publishing service holds the draft row
-- lock while it publishes, so two publishes of one project never race; the unique index refuses it if they did.
-- A row for another workspace is left to the RLS WITH CHECK (42501), like the S1 guards.
CREATE OR REPLACE FUNCTION app.site_versions_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.created_by := app.current_actor_user();
  NEW.created_at := pg_catalog.now();
  IF NEW.workspace_id IS NOT DISTINCT FROM app.current_workspace() THEN
    NEW.number := COALESCE((SELECT max(v.number) FROM app.site_versions v
                             WHERE v.workspace_id = NEW.workspace_id AND v.project_id = NEW.project_id), 0) + 1;
  ELSE
    NEW.number := NULL;
  END IF;
  RETURN NEW;
END
$$;

GRANT INSERT (assets, publish_key, number) ON "app"."site_versions" TO app_user;

-- =============================================================== staging_links
CREATE TABLE "app"."staging_links" (
    "id" UUID NOT NULL DEFAULT app.uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" UUID,

    CONSTRAINT "staging_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "staging_links_workspace_id_id_key" ON "app"."staging_links"("workspace_id", "id");
CREATE INDEX "staging_links_workspace_id_project_id_created_at_idx"
  ON "app"."staging_links"("workspace_id", "project_id", "created_at" DESC);

ALTER TABLE "app"."staging_links"
  ADD CONSTRAINT "staging_links_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "app"."workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "staging_links_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id")
    REFERENCES "app"."projects"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Approved decision 1: a staging link lives at most 14 days (STAGING_TOKEN.maxLifetimeSeconds).
  ADD CONSTRAINT "staging_links_lifetime" CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '14 days' + interval '1 minute'),
  ADD CONSTRAINT "staging_links_revocation_pair" CHECK ((revoked_at IS NULL) = (revoked_by IS NULL));

-- The database sets the author and the time; revocation is final and the only change a link can have.
CREATE FUNCTION app.staging_links_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := app.current_actor_user();
    NEW.revoked_at := NULL;
    NEW.revoked_by := NULL;
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked staging link cannot change' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.workspace_id, NEW.project_id, NEW.created_by, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.project_id, OLD.created_by, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'only the revocation of a staging link can change' USING ERRCODE = '42501';
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at := pg_catalog.now();
    NEW.revoked_by := app.current_actor_user();
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.staging_links_guard() FROM PUBLIC;
CREATE TRIGGER staging_links_guard BEFORE INSERT OR UPDATE ON "app"."staging_links"
  FOR EACH ROW EXECUTE FUNCTION app.staging_links_guard();

CREATE FUNCTION app.staging_links_reject_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'staging_links cannot be deleted (% rejected)', TG_OP USING ERRCODE = '42501';
END
$$;
REVOKE ALL ON FUNCTION app.staging_links_reject_delete() FROM PUBLIC;
CREATE TRIGGER staging_links_no_delete BEFORE DELETE ON "app"."staging_links"
  FOR EACH ROW EXECUTE FUNCTION app.staging_links_reject_delete();
CREATE TRIGGER staging_links_no_truncate BEFORE TRUNCATE ON "app"."staging_links"
  FOR EACH STATEMENT EXECUTE FUNCTION app.staging_links_reject_delete();

ALTER TABLE "app"."staging_links" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_select ON "app"."staging_links" FOR SELECT TO app_user
  USING (workspace_id = app.current_workspace());
-- Whoever may publish to staging may share it (decision 4: owners, admins, editors).
CREATE POLICY editor_insert ON "app"."staging_links" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor')
              AND app.project_editable(project_id));
-- Turning a link off is protective, so it is allowed in a suspended workspace too (as for preview links).
CREATE POLICY editor_update ON "app"."staging_links" FOR UPDATE TO app_user
  USING (workspace_id = app.current_workspace()
         AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'))
  WITH CHECK (workspace_id = app.current_workspace()
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'));

GRANT SELECT ON "app"."staging_links" TO app_user;
GRANT INSERT (id, workspace_id, project_id, created_at, expires_at) ON "app"."staging_links" TO app_user;
GRANT UPDATE (revoked_at, revoked_by) ON "app"."staging_links" TO app_user;

-- =============================================================== what the visitor functions read
CREATE POLICY definer_select ON "app"."staging_links" FOR SELECT TO svc_definer USING (true);
CREATE POLICY definer_select ON "app"."site_pointers" FOR SELECT TO svc_definer USING (true);
CREATE POLICY definer_select ON "app"."site_versions" FOR SELECT TO svc_definer USING (true);
GRANT SELECT (id, workspace_id, project_id, expires_at, revoked_at) ON "app"."staging_links" TO svc_definer;
GRANT SELECT (workspace_id, project_id, kind, site_version_id) ON "app"."site_pointers" TO svc_definer;
GRANT SELECT (id, workspace_id, project_id, kind, config, assets, created_at) ON "app"."site_versions" TO svc_definer;

-- =============================================================== resolve_host with `live`
-- Same contract as P1 S7 plus a fourth column. The outcome is `live` exactly when it would be `placeholder` and
-- the project has a live pointer; maintenance and unknown are unchanged, so a suspended workspace or a paused
-- project never shows its published site.
DROP FUNCTION app.resolve_host(text);
CREATE FUNCTION app.resolve_host(p_hostname text)
RETURNS TABLE (outcome text, workspace_id uuid, project_id uuid, site_version_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_hostname IS NOT NULL AND char_length(p_hostname) <= 253 THEN
    RETURN QUERY
      SELECT CASE
               WHEN w.status <> 'active' OR w.deleted_at IS NOT NULL THEN 'maintenance'
               WHEN p.status = 'paused' THEN 'maintenance'
               WHEN sp.site_version_id IS NOT NULL THEN 'live'
               ELSE 'placeholder'
             END,
             d.workspace_id, d.project_id,
             CASE WHEN w.status = 'active' AND w.deleted_at IS NULL AND p.status <> 'paused'
                  THEN sp.site_version_id END
        FROM app.domains d
        JOIN app.projects p ON p.workspace_id = d.workspace_id AND p.id = d.project_id
        JOIN app.workspaces w ON w.id = d.workspace_id
        LEFT JOIN app.site_pointers sp
          ON sp.workspace_id = d.workspace_id AND sp.project_id = d.project_id AND sp.kind = 'live'
       WHERE d.hostname = pg_catalog.lower(p_hostname)
         AND d.deleted_at IS NULL AND d.status = 'active' AND d.type IN ('subdomain', 'custom')
         AND p.deleted_at IS NULL AND p.status <> 'archived';
    IF FOUND THEN
      RETURN;
    END IF;
  END IF;
  RETURN QUERY SELECT 'unknown'::text, NULL::uuid, NULL::uuid, NULL::uuid;
END
$$;
REVOKE ALL ON FUNCTION app.resolve_host(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_host(text) TO app_public;

-- =============================================================== get_published_version
-- The content of one live version. Versions are immutable, so the sites app caches the answer by id. The id comes
-- from resolve_host (server side), never from a visitor; a staging version or an unknown id returns no row.
CREATE FUNCTION app.get_published_version(p_version_id uuid)
RETURNS TABLE (config jsonb, assets jsonb, published_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT v.config, v.assets, v.created_at
    FROM app.site_versions v
   WHERE v.id = p_version_id AND v.kind = 'live'
$$;
REVOKE ALL ON FUNCTION app.get_published_version(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.get_published_version(uuid) TO app_public;

-- =============================================================== get_staging_site
-- What a staging link may show now. Called only after the sites app verified the link's signature and expiry, so
-- link ids cannot be probed. Exactly one row:
--   ok           the link is active and its project has a staging version: the version's content and its name
--   revoked      the link was turned off
--   expired      the link's time is over (the token's own expiry is checked first; this is the database's)
--   unavailable  the workspace is suspended or deleted, the project is paused, archived or deleted, or nothing
--                was published to staging yet
--   unknown      no such link
-- `sender` (the workspace name, what the freelancer shows their client anyway) is filled for all but unknown.
CREATE FUNCTION app.get_staging_site(p_link_id uuid)
RETURNS TABLE (status text, site_version_id uuid, config jsonb, assets jsonb, published_at timestamptz, sender text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_link record;
BEGIN
  SELECT l.workspace_id, l.project_id, l.expires_at, l.revoked_at, w.name AS sender,
         (w.status = 'active' AND w.deleted_at IS NULL AND p.deleted_at IS NULL
          AND p.status NOT IN ('paused', 'archived')) AS servable
    INTO v_link
    FROM app.staging_links l
    JOIN app.workspaces w ON w.id = l.workspace_id
    JOIN app.projects p ON p.workspace_id = l.workspace_id AND p.id = l.project_id
   WHERE l.id = p_link_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unknown'::text, NULL::uuid, NULL::jsonb, NULL::jsonb, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;
  IF v_link.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT 'revoked'::text, NULL::uuid, NULL::jsonb, NULL::jsonb, NULL::timestamptz, v_link.sender;
    RETURN;
  END IF;
  IF v_link.expires_at <= pg_catalog.now() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::jsonb, NULL::jsonb, NULL::timestamptz, v_link.sender;
    RETURN;
  END IF;
  IF v_link.servable THEN
    RETURN QUERY
      SELECT 'ok'::text, v.id, v.config, v.assets, v.created_at, v_link.sender
        FROM app.site_pointers sp
        JOIN app.site_versions v ON v.workspace_id = sp.workspace_id AND v.id = sp.site_version_id
       WHERE sp.workspace_id = v_link.workspace_id AND sp.project_id = v_link.project_id AND sp.kind = 'staging';
    IF FOUND THEN
      RETURN;
    END IF;
  END IF;
  RETURN QUERY SELECT 'unavailable'::text, NULL::uuid, NULL::jsonb, NULL::jsonb, NULL::timestamptz, v_link.sender;
END
$$;
REVOKE ALL ON FUNCTION app.get_staging_site(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.get_staging_site(uuid) TO app_public;

-- =============================================================== ownership (S1-2: EXECUTE before the transfer)
GRANT CREATE ON SCHEMA "app" TO svc_definer;
ALTER FUNCTION app.resolve_host(text) OWNER TO svc_definer;
ALTER FUNCTION app.get_published_version(uuid) OWNER TO svc_definer;
ALTER FUNCTION app.get_staging_site(uuid) OWNER TO svc_definer;
REVOKE CREATE ON SCHEMA "app" FROM svc_definer;
