-- =====================================================================================================
-- P2 S5b: template tables and the template catalogue (FR-TPL-01, FR-TPL-10; ADR-004; SRS 5.3). Runs as
-- `migrator` after 20261031120000_p1_s9_outbox_sweep_order. Forward-only; rollback is a new migration that
-- drops the two tables, the two enums and the five functions (nothing else references them yet).
--
-- Two tables: `templates` (identity, status, owner) and `template_versions` (the immutable content: the full
-- SiteConfig and the onboarding manifest). `workspace_id` NULL means a platform built-in; a non-NULL value is a
-- private template of that workspace. Marketplace templates (P6) will be non-NULL with visibility `marketplace`.
--
-- Who can do what:
--   * app_user (a tenant): read and write ONLY the private templates of its own workspace (RLS; owners, admins and
--     editors write). It can never create or change a platform or marketplace template, and versions are
--     insert-only for everybody (trigger).
--   * The catalogue (published platform and marketplace templates) is read through two SECURITY DEFINER
--     functions, executable by app_user and app_public (the visitor role for the preview route). The tables
--     themselves stay invisible across tenants, so the cross-tenant isolation matrix applies unchanged.
--   * Platform built-ins are written by one operator function, executable by `migrator` only (the seed command).
-- =====================================================================================================

-- ---------------------------------------------------------------- 1. tables
CREATE TYPE "app"."template_status" AS ENUM ('draft', 'published', 'archived');
CREATE TYPE "app"."template_visibility" AS ENUM ('private', 'platform', 'marketplace');

CREATE TABLE "app"."templates" (
    "id" UUID NOT NULL DEFAULT app.uuid_generate_v7(),
    "workspace_id" UUID,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "app"."template_status" NOT NULL DEFAULT 'draft',
    "visibility" "app"."template_visibility" NOT NULL DEFAULT 'private',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app"."template_versions" (
    "id" UUID NOT NULL DEFAULT app.uuid_generate_v7(),
    "workspace_id" UUID,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "schema_version" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "manifest" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "templates_workspace_id_status_idx" ON "app"."templates"("workspace_id", "status");
CREATE UNIQUE INDEX "templates_workspace_id_id_key" ON "app"."templates"("workspace_id", "id");
CREATE UNIQUE INDEX "templates_workspace_id_slug_key" ON "app"."templates"("workspace_id", "slug");
CREATE INDEX "template_versions_workspace_id_template_id_idx" ON "app"."template_versions"("workspace_id", "template_id");
CREATE UNIQUE INDEX "template_versions_template_id_version_key" ON "app"."template_versions"("template_id", "version");
CREATE UNIQUE INDEX "template_versions_workspace_id_id_key" ON "app"."template_versions"("workspace_id", "id");

ALTER TABLE "app"."templates" ADD CONSTRAINT "templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "app"."template_versions" ADD CONSTRAINT "template_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Composite FK (SRS 5.3 item 4): a private template's version belongs to a template of the same workspace. It is
-- not enforced when workspace_id is NULL (MATCH SIMPLE), so platform rows are covered by the trigger in section 2.
ALTER TABLE "app"."template_versions" ADD CONSTRAINT "template_versions_workspace_id_template_id_fkey" FOREIGN KEY ("workspace_id", "template_id") REFERENCES "app"."templates"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- 2. integrity
-- Platform built-ins are unique by slug (NULL workspace ids never collide in the regular unique index).
CREATE UNIQUE INDEX "templates_platform_slug_key" ON "app"."templates" ("slug") WHERE "workspace_id" IS NULL;

ALTER TABLE "app"."templates"
  ADD CONSTRAINT "templates_slug_format" CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  ADD CONSTRAINT "templates_name_length" CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  ADD CONSTRAINT "templates_description_length" CHECK (char_length(btrim(description)) BETWEEN 1 AND 300),
  ADD CONSTRAINT "templates_category_known" CHECK (category IN
    ('gym', 'taxi', 'wedding-event', 'distributor', 'salon', 'clinic', 'restaurant', 'coaching', 'real-estate', 'generic')),
  -- Platform built-in <=> no owning workspace. Nothing else may claim either shape.
  ADD CONSTRAINT "templates_platform_owner" CHECK ((workspace_id IS NULL) = (visibility = 'platform'));

ALTER TABLE "app"."template_versions"
  ADD CONSTRAINT "template_versions_version_range" CHECK (version BETWEEN 1 AND 10000),
  ADD CONSTRAINT "template_versions_schema_version" CHECK (schema_version ~ '^[0-9]{1,3}[.][0-9]{1,3}$'),
  ADD CONSTRAINT "template_versions_content_hash" CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  -- Same bounds as the SiteConfig contract (256 KB) and a generous manifest bound; objects only.
  ADD CONSTRAINT "template_versions_config_shape" CHECK (
    jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 262144),
  ADD CONSTRAINT "template_versions_manifest_shape" CHECK (
    jsonb_typeof(manifest) = 'object' AND octet_length(manifest::text) <= 65536);

-- A version belongs to a template of the same owner (also for platform rows, where the composite FK is silent) and
-- numbers the versions 1, 2, 3 ... without gaps. Runs as the writing role, so RLS applies to its own reads.
-- AFTER INSERT on purpose: the row-level-security WITH CHECK is evaluated before AFTER triggers, so a cross-tenant
-- attempt is always a plain 42501 and never a hint about whether someone else's template exists (a BEFORE trigger
-- would run first and answer 23503 for a template the caller cannot see).
CREATE FUNCTION app.template_versions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_next integer;
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM app.templates t
        WHERE t.id = NEW.template_id AND t.workspace_id IS NOT DISTINCT FROM NEW.workspace_id) THEN
    RAISE EXCEPTION 'a template version must belong to a template of the same owner' USING ERRCODE = '23503';
  END IF;
  SELECT COALESCE(MAX(v.version), 0) + 1 INTO v_next
    FROM app.template_versions v WHERE v.template_id = NEW.template_id AND v.id <> NEW.id;
  IF NEW.version <> v_next THEN
    RAISE EXCEPTION 'the next version of this template is %', v_next USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.template_versions_guard() FROM PUBLIC;
CREATE TRIGGER template_versions_guard AFTER INSERT ON "app"."template_versions"
  FOR EACH ROW EXECUTE FUNCTION app.template_versions_guard();

-- Versions are immutable (IMPLEMENTATION_PLAN Q7 pattern, as for audit_logs): no role has UPDATE or DELETE and
-- this trigger also stops the owner and TRUNCATE.
CREATE FUNCTION app.template_versions_reject_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'template_versions is immutable (% rejected)', TG_OP USING ERRCODE = '42501';
END
$$;
REVOKE ALL ON FUNCTION app.template_versions_reject_change() FROM PUBLIC;
CREATE TRIGGER template_versions_immutable BEFORE UPDATE OR DELETE ON "app"."template_versions"
  FOR EACH ROW EXECUTE FUNCTION app.template_versions_reject_change();
CREATE TRIGGER template_versions_no_truncate BEFORE TRUNCATE ON "app"."template_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION app.template_versions_reject_change();

-- Identity of a template never changes after creation: owner, visibility and slug are fixed (visibility changes
-- such as private -> marketplace will be a reviewed function in P6, which replaces this guard).
CREATE FUNCTION app.templates_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.visibility IS DISTINCT FROM OLD.visibility
     OR NEW.slug IS DISTINCT FROM OLD.slug OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'a template''s owner, visibility and slug cannot change' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.templates_guard() FROM PUBLIC;
CREATE TRIGGER templates_guard BEFORE UPDATE ON "app"."templates"
  FOR EACH ROW EXECUTE FUNCTION app.templates_guard();

-- ---------------------------------------------------------------- 3. row-level security (SRS 5.3 items 2-3)
ALTER TABLE "app"."templates"         ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."template_versions" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

-- A tenant sees only its own rows: platform rows (workspace_id NULL) never match `workspace_id = current_workspace()`.
CREATE POLICY tenant_select ON "app"."templates" FOR SELECT TO app_user
  USING (workspace_id = app.current_workspace());
-- Tenants create and edit only PRIVATE templates (marketplace submission is P6); owners, admins and editors write.
CREATE POLICY editor_insert ON "app"."templates" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace() AND visibility = 'private' AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'));
CREATE POLICY editor_update ON "app"."templates" FOR UPDATE TO app_user
  USING (workspace_id = app.current_workspace() AND visibility = 'private' AND (SELECT app.workspace_writable())
         AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'))
  WITH CHECK (workspace_id = app.current_workspace() AND visibility = 'private' AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'));

CREATE POLICY tenant_select ON "app"."template_versions" FOR SELECT TO app_user
  USING (workspace_id = app.current_workspace());
CREATE POLICY editor_insert ON "app"."template_versions" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'));

-- svc_definer (the owner of the functions below, NOBYPASSRLS) gets narrow, visible policies: it reads both tables
-- (the catalogue functions filter to published rows) and writes platform rows only.
CREATE POLICY definer_select ON "app"."templates" FOR SELECT TO svc_definer USING (true);
CREATE POLICY definer_insert ON "app"."templates" FOR INSERT TO svc_definer
  WITH CHECK (workspace_id IS NULL AND visibility = 'platform');
CREATE POLICY definer_update ON "app"."templates" FOR UPDATE TO svc_definer
  USING (workspace_id IS NULL AND visibility = 'platform')
  WITH CHECK (workspace_id IS NULL AND visibility = 'platform');
CREATE POLICY definer_select ON "app"."template_versions" FOR SELECT TO svc_definer USING (true);
CREATE POLICY definer_insert ON "app"."template_versions" FOR INSERT TO svc_definer WITH CHECK (workspace_id IS NULL);

-- ---------------------------------------------------------------- 4. privileges (least privilege)
GRANT SELECT ON "app"."templates", "app"."template_versions" TO app_user;
-- `visibility` is in the INSERT list because Prisma sends enum defaults explicitly; the policy pins it to private.
GRANT INSERT (id, workspace_id, slug, name, category, description, status, visibility, created_by, created_at, updated_at)
  ON "app"."templates" TO app_user;
GRANT UPDATE (name, description, status, deleted_at, updated_at) ON "app"."templates" TO app_user;
GRANT INSERT (id, workspace_id, template_id, version, schema_version, config, manifest, content_hash, created_by, created_at)
  ON "app"."template_versions" TO app_user;

GRANT SELECT (id, workspace_id, slug, name, category, description, status, visibility, created_at, updated_at, deleted_at)
  ON "app"."templates" TO svc_definer;
GRANT INSERT (workspace_id, slug, name, category, description, status, visibility) ON "app"."templates" TO svc_definer;
GRANT UPDATE (name, category, description, status, deleted_at, updated_at) ON "app"."templates" TO svc_definer;
GRANT SELECT (id, workspace_id, template_id, version, schema_version, config, manifest, content_hash, created_at)
  ON "app"."template_versions" TO svc_definer;
GRANT INSERT (workspace_id, template_id, version, schema_version, config, manifest, content_hash)
  ON "app"."template_versions" TO svc_definer;

-- ---------------------------------------------------------------- 5. SECURITY DEFINER functions
-- The catalogue: published platform and marketplace templates, latest version, nothing else. Both functions pin
-- search_path and take no context from the caller, so the answer cannot depend on anything a visitor sets.
CREATE FUNCTION app.list_catalog_templates()
RETURNS TABLE (template_id uuid, slug text, name text, category text, description text, visibility text,
               version integer, content_hash text, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.id, t.slug, t.name, t.category, t.description, t.visibility::text, v.version, v.content_hash, t.updated_at
    FROM app.templates t
    JOIN LATERAL (SELECT tv.version, tv.content_hash FROM app.template_versions tv
                   WHERE tv.template_id = t.id ORDER BY tv.version DESC LIMIT 1) v ON true
   WHERE t.status = 'published' AND t.visibility IN ('platform', 'marketplace') AND t.deleted_at IS NULL
   ORDER BY t.category, t.name
$$;

-- One catalogue template with its content. `p_version` NULL means the latest. An unknown, draft, archived,
-- private or deleted template returns no row (the caller cannot tell them apart).
CREATE FUNCTION app.get_catalog_template(p_template_id uuid, p_version integer DEFAULT NULL)
RETURNS TABLE (template_id uuid, slug text, name text, category text, description text, visibility text,
               version integer, schema_version text, config jsonb, manifest jsonb, content_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.id, t.slug, t.name, t.category, t.description, t.visibility::text, v.version, v.schema_version,
         v.config, v.manifest, v.content_hash
    FROM app.templates t
    JOIN app.template_versions v ON v.template_id = t.id
   WHERE t.id = p_template_id
     AND t.status = 'published' AND t.visibility IN ('platform', 'marketplace') AND t.deleted_at IS NULL
     AND v.version = COALESCE(p_version, (SELECT MAX(x.version) FROM app.template_versions x WHERE x.template_id = t.id))
$$;

-- The seed path for platform built-ins (operator only). Idempotent: an unchanged content hash creates no new
-- version; a changed one appends the next version (older versions stay, immutable). Concurrent runs for one slug
-- are serialised. Every change leaves a platform audit row. Validation beyond the CHECK constraints (the full
-- Template schema) happens in the seed command before it calls this.
CREATE FUNCTION app.operator_publish_builtin_template(
  p_slug text, p_name text, p_category text, p_description text, p_schema_version text,
  p_config jsonb, p_manifest jsonb, p_content_hash text)
RETURNS TABLE (template_id uuid, version integer, created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_id uuid;
  v_version integer;
  v_hash text;
  v_created boolean := false;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('template:' || p_slug, 0));
  SELECT t.id INTO v_id FROM app.templates t WHERE t.workspace_id IS NULL AND t.slug = p_slug;
  IF v_id IS NULL THEN
    INSERT INTO app.templates (workspace_id, slug, name, category, description, status, visibility)
    VALUES (NULL, p_slug, p_name, p_category, p_description, 'published', 'platform')
    RETURNING id INTO v_id;
    INSERT INTO app.audit_logs (id, workspace_id, actor_type, action, target_type, target_id, result, metadata)
    VALUES (app.uuid_generate_v7(), NULL, 'system', 'admin.template.created', 'template', v_id::text, 'success',
            pg_catalog.jsonb_build_object('slug', p_slug));
  ELSE
    UPDATE app.templates SET name = p_name, category = p_category, description = p_description,
           status = 'published', deleted_at = NULL, updated_at = pg_catalog.now()
     WHERE id = v_id;
  END IF;
  SELECT v.version, v.content_hash INTO v_version, v_hash
    FROM app.template_versions v WHERE v.template_id = v_id ORDER BY v.version DESC LIMIT 1;
  IF v_hash IS DISTINCT FROM p_content_hash THEN
    v_version := COALESCE(v_version, 0) + 1;
    INSERT INTO app.template_versions (workspace_id, template_id, version, schema_version, config, manifest, content_hash)
    VALUES (NULL, v_id, v_version, p_schema_version, p_config, p_manifest, p_content_hash);
    v_created := true;
    INSERT INTO app.audit_logs (id, workspace_id, actor_type, action, target_type, target_id, result, metadata)
    VALUES (app.uuid_generate_v7(), NULL, 'system', 'admin.template.version_published', 'template', v_id::text,
            'success', pg_catalog.jsonb_build_object('slug', p_slug, 'version', v_version, 'content_hash', p_content_hash));
  END IF;
  RETURN QUERY SELECT v_id, v_version, v_created;
END
$$;

-- Takes a platform built-in out of the catalogue (it stays in the database with all its versions).
CREATE FUNCTION app.operator_archive_builtin_template(p_slug text, p_reason text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE app.templates SET status = 'archived', updated_at = pg_catalog.now()
   WHERE workspace_id IS NULL AND slug = p_slug AND status <> 'archived'
   RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO app.audit_logs (id, workspace_id, actor_type, action, target_type, target_id, result, metadata)
  VALUES (app.uuid_generate_v7(), NULL, 'system', 'admin.template.archived', 'template', v_id::text, 'success',
          pg_catalog.jsonb_build_object('slug', p_slug, 'reason', p_reason));
  RETURN true;
END
$$;

-- EXECUTE before the ownership transfer (S1-2). The catalogue: tenants and visitors. The operator functions:
-- migrator only (granted after the transfer, below).
REVOKE ALL ON FUNCTION app.list_catalog_templates() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.get_catalog_template(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.operator_publish_builtin_template(text, text, text, text, text, jsonb, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.operator_archive_builtin_template(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_catalog_templates() TO app_user, app_public;
GRANT EXECUTE ON FUNCTION app.get_catalog_template(uuid, integer) TO app_user, app_public;

GRANT CREATE ON SCHEMA "app" TO svc_definer;
ALTER FUNCTION app.list_catalog_templates() OWNER TO svc_definer;
ALTER FUNCTION app.get_catalog_template(uuid, integer) OWNER TO svc_definer;
ALTER FUNCTION app.operator_publish_builtin_template(text, text, text, text, text, jsonb, jsonb, text) OWNER TO svc_definer;
ALTER FUNCTION app.operator_archive_builtin_template(text, text) OWNER TO svc_definer;
REVOKE CREATE ON SCHEMA "app" FROM svc_definer;
-- The ownership transfer rewrites ACL entries naming the old owner, so a grant to migrator itself must be made
-- by the new owner (migrator holds SET on svc_definer, Spike B B-7).
SET ROLE svc_definer;
GRANT EXECUTE ON FUNCTION app.operator_publish_builtin_template(text, text, text, text, text, jsonb, jsonb, text),
  app.operator_archive_builtin_template(text, text) TO migrator;
RESET ROLE;
