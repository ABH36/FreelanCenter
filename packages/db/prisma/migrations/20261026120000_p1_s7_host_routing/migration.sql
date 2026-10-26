-- =====================================================================================================
-- P1 S7: public host resolution for apps/sites (SRS 4.3 visitor flow, 5.3 item 1; FR-DOM-01, FR-DOM-07,
-- FR-WS-04 sites part). Runs as `migrator` after 20261024090000_p1_s6_projects_lifecycle.
--
-- `app.resolve_host` is the first SECURITY DEFINER function for `app_public`, the visitor role, which holds no
-- table privilege at all (SRS 5.3 item 1). It answers one question, "what may this host show?", with an
-- outcome and two internal ids, and nothing else: no names, no contact data, no status history. The sites app
-- caches the answer per host (Upstash, positive and negative) and the dashboard invalidates it through the
-- outbox when a project's status or subdomains change.
--
-- No table, column or policy changes for app_user. svc_definer gains SELECT on two status columns.
-- =====================================================================================================

-- Outcomes (the sites app renders one page per outcome; P3 adds `live` with the published SiteVersion id):
--   placeholder  an active domain of a project that is not paused or archived, in an active workspace
--   maintenance  the workspace is suspended or scheduled for deletion (FR-WS-04), or the project is paused
--   unknown      no active domain with this host name, a deleted or archived project, a portal domain, bad input
-- The workspace check comes first, so a suspended workspace shows the maintenance page on every host it owns.
-- Host names are stored in lower case (allocator); the caller normalises (port, trailing dot) and this function
-- lower-cases again, so a mixed-case Host header cannot miss. The context settings (app.workspace_id,
-- app.user_id) are not read: a visitor's answer cannot depend on anything the caller sets.
CREATE FUNCTION app.resolve_host(p_hostname text)
RETURNS TABLE (outcome text, workspace_id uuid, project_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_hostname IS NOT NULL AND char_length(p_hostname) <= 253 THEN
    RETURN QUERY
      SELECT CASE
               WHEN w.status <> 'active' OR w.deleted_at IS NOT NULL THEN 'maintenance'
               WHEN p.status = 'paused' THEN 'maintenance'
               ELSE 'placeholder'
             END,
             d.workspace_id, d.project_id
        FROM app.domains d
        JOIN app.projects p ON p.workspace_id = d.workspace_id AND p.id = d.project_id
        JOIN app.workspaces w ON w.id = d.workspace_id
       WHERE d.hostname = pg_catalog.lower(p_hostname)
         AND d.deleted_at IS NULL AND d.status = 'active' AND d.type IN ('subdomain', 'custom')
         AND p.deleted_at IS NULL AND p.status <> 'archived';
    IF FOUND THEN
      RETURN;
    END IF;
  END IF;
  RETURN QUERY SELECT 'unknown'::text, NULL::uuid, NULL::uuid;
END
$$;

-- What svc_definer additionally may read for it (the definer_select policies on domains, projects and
-- workspaces exist since S1/S6; workspaces (id, status, deleted_at) is already granted).
GRANT SELECT (status) ON "app"."projects" TO svc_definer;
GRANT SELECT (status) ON "app"."domains" TO svc_definer;

-- EXECUTE before the ownership transfer (S1-2). app_public only: neither app_user nor the other roles need it.
REVOKE ALL ON FUNCTION app.resolve_host(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_host(text) TO app_public;

GRANT CREATE ON SCHEMA "app" TO svc_definer;
ALTER FUNCTION app.resolve_host(text) OWNER TO svc_definer;
REVOKE CREATE ON SCHEMA "app" FROM svc_definer;
