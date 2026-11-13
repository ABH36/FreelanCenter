-- =====================================================================================================
-- P2 S10 (acceptance C-25, Owner decision 2026-11-12): the "expired" and "withdrawn" pages of a preview link say who
-- sent it ("Ask Tester One Digital for a new link"), so a prospect knows whom to contact. Runs as `migrator` after
-- 20261113120000_p2_s10_preview_link_prospect. Forward-only; rollback is a new migration that drops the function
-- and revokes the column grant.
--
-- One visitor function returns the name of the workspace that made a link. It is called only for a link whose
-- signature the sites app has already verified (an expired or revoked link), never for a forged one, so it cannot be
-- used to look up workspaces by guessing ids. It returns nothing for an unknown link or a deleted workspace. The
-- workspace's name is what the freelancer shows to their prospect anyway; no other field is exposed.
-- =====================================================================================================

GRANT SELECT (workspace_id) ON "app"."template_preview_links" TO svc_definer;

CREATE FUNCTION app.preview_link_sender(p_link_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT w.name
    FROM app.template_preview_links l
    JOIN app.workspaces w ON w.id = l.workspace_id
   WHERE l.id = p_link_id AND w.deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION app.preview_link_sender(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.preview_link_sender(uuid) TO app_public;

GRANT CREATE ON SCHEMA "app" TO svc_definer;
ALTER FUNCTION app.preview_link_sender(uuid) OWNER TO svc_definer;
REVOKE CREATE ON SCHEMA "app" FROM svc_definer;
