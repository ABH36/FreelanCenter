-- =====================================================================================================
-- P2 S8b: revocable template preview links (FR-TPL-09). Runs as `migrator` after
-- 20261105120000_p2_s5b_templates. Forward-only; rollback is a new migration that drops the function, the table
-- and the two trigger functions (nothing else references them).
--
-- A preview link is still a signed token (packages/hosting). From S8b a freshly made link also carries a link id
-- (`lid`, the id of a row here). The row holds no secret and no personal data: not the token, not the prospect's
-- name (only "personalised yes/no"). Revoking sets `revoked_at`; the sites app asks `app.is_preview_link_revoked`
-- (app_public, a visitor function) before it serves a link that carries an id. Links made before S8b, and links
-- made by the operator script, carry no id: they expire normally and cannot be revoked individually.
--
-- Who can do what:
--   * app_user (a tenant): read the links of its own workspace (RLS); owners, admins and editors create them and
--     revoke them (the only UPDATE is the two revocation columns, one way, once). Nobody deletes.
--   * app_public (visitors): no table privilege; one SECURITY DEFINER function that answers revoked or not.
-- =====================================================================================================

CREATE TABLE "app"."template_preview_links" (
    "id" UUID NOT NULL DEFAULT app.uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "personalised" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" UUID,

    CONSTRAINT "template_preview_links_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "template_preview_links_workspace_id_created_at_idx"
  ON "app"."template_preview_links"("workspace_id", "created_at" DESC);
CREATE UNIQUE INDEX "template_preview_links_workspace_id_id_key"
  ON "app"."template_preview_links"("workspace_id", "id");

ALTER TABLE "app"."template_preview_links"
  ADD CONSTRAINT "template_preview_links_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "app"."workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- `template_id` is deliberately not a foreign key: it names a platform catalogue template (global, read-only for
  -- tenants), and SRS 5.3 item 4 allows a reference between tenant tables only when it is composite on workspace_id,
  -- which a platform template (workspace_id NULL) cannot satisfy. The service proves the template is in the
  -- catalogue before it stores the id.
  -- A link lives at most 30 days (PREVIEW_TOKEN.maxLifetimeSeconds) and expires after it was made.
  ADD CONSTRAINT "template_preview_links_lifetime" CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '30 days' + interval '1 minute'),
  ADD CONSTRAINT "template_preview_links_revocation_pair" CHECK ((revoked_at IS NULL) = (revoked_by IS NULL));

-- Revocation is final: a revoked link cannot be un-revoked or re-attributed, and nothing else may change.
CREATE FUNCTION app.template_preview_links_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked preview link cannot change' USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.template_id IS DISTINCT FROM OLD.template_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.personalised IS DISTINCT FROM OLD.personalised THEN
    RAISE EXCEPTION 'only the revocation of a preview link can change' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.template_preview_links_guard() FROM PUBLIC;
CREATE TRIGGER template_preview_links_guard BEFORE UPDATE ON "app"."template_preview_links"
  FOR EACH ROW EXECUTE FUNCTION app.template_preview_links_guard();

CREATE FUNCTION app.template_preview_links_reject_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'template_preview_links cannot be deleted (% rejected)', TG_OP USING ERRCODE = '42501';
END
$$;
REVOKE ALL ON FUNCTION app.template_preview_links_reject_delete() FROM PUBLIC;
CREATE TRIGGER template_preview_links_no_delete BEFORE DELETE ON "app"."template_preview_links"
  FOR EACH ROW EXECUTE FUNCTION app.template_preview_links_reject_delete();
CREATE TRIGGER template_preview_links_no_truncate BEFORE TRUNCATE ON "app"."template_preview_links"
  FOR EACH STATEMENT EXECUTE FUNCTION app.template_preview_links_reject_delete();

-- ---------------------------------------------------------------- row-level security
ALTER TABLE "app"."template_preview_links" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_select ON "app"."template_preview_links" FOR SELECT TO app_user
  USING (workspace_id = app.current_workspace());
CREATE POLICY editor_insert ON "app"."template_preview_links" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'));
-- Revoking is allowed in a suspended workspace too (Owner decision 2026-11-12): turning a public link off is a
-- protective action. Creating links still needs a writable workspace (editor_insert). The column privileges and the
-- guard trigger limit this policy to the revocation columns.
CREATE POLICY editor_update ON "app"."template_preview_links" FOR UPDATE TO app_user
  USING (workspace_id = app.current_workspace()
         AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'))
  WITH CHECK (workspace_id = app.current_workspace()
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'));
-- svc_definer (owner of the visitor function below, NOBYPASSRLS) may read the table: nothing else.
CREATE POLICY definer_select ON "app"."template_preview_links" FOR SELECT TO svc_definer USING (true);

-- ---------------------------------------------------------------- privileges (least privilege)
GRANT SELECT ON "app"."template_preview_links" TO app_user;
GRANT INSERT (id, workspace_id, template_id, created_by, personalised, created_at, expires_at)
  ON "app"."template_preview_links" TO app_user;
GRANT UPDATE (revoked_at, revoked_by) ON "app"."template_preview_links" TO app_user;
GRANT SELECT (id, revoked_at) ON "app"."template_preview_links" TO svc_definer;

-- ---------------------------------------------------------------- visitor function
-- True only for a link that exists and was revoked. An unknown id is "not revoked" (the signature already proved
-- the link is ours; links without a row are the legacy and operator links described above). Takes nothing from
-- the caller but the id; pins the search path.
CREATE FUNCTION app.is_preview_link_revoked(p_link_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE((SELECT l.revoked_at IS NOT NULL FROM app.template_preview_links l WHERE l.id = p_link_id), false)
$$;

REVOKE ALL ON FUNCTION app.is_preview_link_revoked(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_preview_link_revoked(uuid) TO app_public;

GRANT CREATE ON SCHEMA "app" TO svc_definer;
ALTER FUNCTION app.is_preview_link_revoked(uuid) OWNER TO svc_definer;
REVOKE CREATE ON SCHEMA "app" FROM svc_definer;
