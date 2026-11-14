-- =====================================================================================================
-- P3 S2: start a project's draft from a catalogue template (FR-PRJ-01). Runs as `migrator` after
-- 20261114180000_p3_s1_builder_data_model. Forward-only; rollback is a new migration that drops the function.
--
-- A draft records the exact template version it was made from (site_drafts.based_on_template_version_id and
-- projects.template_version_id). Platform template versions have no workspace, so a tenant cannot read their ids
-- through RLS, and the visitor function get_catalog_template returns the version number only. This function gives
-- a signed-in member (app_user only) the latest published version of one catalogue template with its id and
-- content. An unknown, draft, archived, private or deleted template returns no row, as get_catalog_template does.
-- =====================================================================================================

CREATE FUNCTION app.catalog_template_for_draft(p_template_id uuid)
RETURNS TABLE (template_id uuid, version_id uuid, version integer, schema_version text, config jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.id, v.id, v.version, v.schema_version, v.config
    FROM app.templates t
    JOIN app.template_versions v ON v.template_id = t.id
   WHERE t.id = p_template_id
     AND t.status = 'published' AND t.visibility IN ('platform', 'marketplace') AND t.deleted_at IS NULL
     AND v.version = (SELECT MAX(x.version) FROM app.template_versions x WHERE x.template_id = t.id)
$$;

REVOKE ALL ON FUNCTION app.catalog_template_for_draft(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_template_for_draft(uuid) TO app_user;

GRANT CREATE ON SCHEMA "app" TO svc_definer;
ALTER FUNCTION app.catalog_template_for_draft(uuid) OWNER TO svc_definer;
REVOKE CREATE ON SCHEMA "app" FROM svc_definer;
