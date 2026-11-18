-- =====================================================================================================
-- P3 S8b: the client-approval gate, automatic review statuses and review notifications (SRS FR-PUB-06,
-- FR-PRJ-02, FR-NOT-01; module 06; plan approved by the Owner 2026-11-18).
-- Runs as `migrator` after 20261116120000_p3_s8a_client_review. Additive and forward-only; rollback is a new
-- migration that drops the column, the two triggers, the two helpers and the index, restores projects_guard,
-- add_review_comment and approve_review_version from the S6 and S8a migrations, and revokes the grants below.
--
--   workspaces.require_client_approval   FR-PUB-06 policy, default off. Owners and admins change it (RLS
--                                        manager_update), audited by the service.
--   site_versions_approval_gate          With the policy on, a new Live version must carry exactly the content
--                                        (checksum) of a version a client approved for that project (P5105).
--                                        Rollback moves the pointer to an existing version and is not gated.
--   projects_guard                       Also lets the review helpers (svc_definer, flagged in the transaction)
--                                        make two system moves: Draft -> In review, In review -> Approved.
--   staging_links_review_status          AFTER INSERT: a new review link moves a Draft project to In review.
--   approve_review_version               Also moves In review -> Approved and notifies the members.
--   add_review_comment                   Also notifies the members, at most once per link per 15 minutes.
--   review_notify(...)                   helper: one notification per recipient (creator, owners, admins) with
--                                        their category choices, plus an e-mail outbox row where wanted.
-- =====================================================================================================

-- =============================================================== 1. the workspace policy
ALTER TABLE "app"."workspaces" ADD COLUMN "require_client_approval" BOOLEAN NOT NULL DEFAULT false;
-- Owners and admins update the row (policy manager_update); workspaces_guard leaves this column alone. INSERT too:
-- Prisma sends column defaults explicitly when a workspace is created (its creator becomes the owner).
GRANT INSERT (require_client_approval), UPDATE (require_client_approval) ON "app"."workspaces" TO app_user;

-- =============================================================== 2. the Live gate
-- BEFORE INSERT on site_versions, as the publishing member. A row for another workspace is left to the RLS WITH
-- CHECK (as site_pointers_guard does). The approval may come through any link of the project, revoked or expired
-- later or not: an approval is an immutable record of what the client accepted.
CREATE FUNCTION app.site_versions_approval_gate() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.kind <> 'live' OR NEW.workspace_id IS DISTINCT FROM app.current_workspace() THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspaces w WHERE w.id = NEW.workspace_id AND w.require_client_approval)
     AND NOT EXISTS (
       SELECT 1 FROM app.review_approvals a
         JOIN app.site_versions v ON v.workspace_id = a.workspace_id AND v.id = a.site_version_id
        WHERE a.workspace_id = NEW.workspace_id AND a.project_id = NEW.project_id
          AND v.checksum = NEW.checksum) THEN
    RAISE EXCEPTION 'this workspace needs a client approval of exactly this content before it goes live'
      USING ERRCODE = 'P5105';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.site_versions_approval_gate() FROM PUBLIC;
CREATE TRIGGER site_versions_approval_gate BEFORE INSERT ON "app"."site_versions"
  FOR EACH ROW EXECUTE FUNCTION app.site_versions_approval_gate();

-- =============================================================== 3. system review moves in projects_guard
-- As in p1_s6_projects_lifecycle, plus one branch: the review helpers below run as svc_definer and set
-- `app.review_transition` for the length of their UPDATE. Both conditions are needed: a member cannot become
-- svc_definer, and no other svc_definer function sets the flag or may update a project's status.
CREATE OR REPLACE FUNCTION app.projects_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_roles app.member_role[];
  v_role app.member_role;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.status_changed_at := pg_catalog.now();
    NEW.created_by := app.current_actor_user();
    RETURN NEW;
  END IF;
  IF NEW.status = OLD.status THEN
    IF OLD.status = 'archived'
       AND (NEW.name, NEW.category, NEW.city, NEW.client_contact_id, NEW.template_id, NEW.template_version_id,
            NEW.deleted_at)
           IS DISTINCT FROM
           (OLD.name, OLD.category, OLD.city, OLD.client_contact_id, OLD.template_id, OLD.template_version_id,
            OLD.deleted_at) THEN
      RAISE EXCEPTION 'an archived project is read-only; restore it first' USING ERRCODE = 'P5003';
    END IF;
    NEW.status_changed_at := OLD.status_changed_at;
    RETURN NEW;
  END IF;
  v_roles := app.project_transition_roles(OLD.status, NEW.status);
  IF v_roles IS NULL THEN
    RAISE EXCEPTION 'a project cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'P5002';
  END IF;
  IF current_user = 'svc_definer'
     AND pg_catalog.current_setting('app.review_transition', true) = 'on'
     AND ((OLD.status = 'draft' AND NEW.status = 'in_review')
          OR (OLD.status = 'in_review' AND NEW.status = 'approved')) THEN
    NEW.status_changed_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  v_role := app.current_member_role();
  IF v_role IS NULL OR NOT (v_role = ANY (v_roles)) THEN
    RAISE EXCEPTION 'this role may not move a project from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'live' AND NOT EXISTS (
       SELECT 1 FROM app.domains d
        WHERE d.workspace_id = NEW.workspace_id AND d.project_id = NEW.id AND d.type = 'subdomain'
          AND d.status = 'active' AND d.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'a project needs an active platform subdomain before it can go live' USING ERRCODE = 'P5006';
  END IF;
  NEW.status_changed_at := pg_catalog.now();
  RETURN NEW;
END
$$;

-- =============================================================== 4. what svc_definer additionally may touch
-- projects_guard reads the transition table before it recognises the system move.
GRANT EXECUTE ON FUNCTION app.project_transition_roles(app.project_status, app.project_status) TO svc_definer;
GRANT SELECT (status, created_by) ON "app"."projects" TO svc_definer;
GRANT UPDATE (status) ON "app"."projects" TO svc_definer;
CREATE POLICY definer_update ON "app"."projects" FOR UPDATE TO svc_definer
  USING (status IN ('draft', 'in_review') AND deleted_at IS NULL)
  WITH CHECK (status IN ('in_review', 'approved'));
GRANT SELECT (created_at) ON "app"."notifications" TO svc_definer;
GRANT SELECT (in_app) ON "app"."notification_preferences" TO svc_definer;
-- svc_definer already inserts (id, workspace_id, event, payload) for host-cache rows (p1_s8, policy
-- definer_insert); this second permissive policy adds fresh notification e-mail rows and nothing else.
CREATE POLICY definer_insert_notification_email ON "app"."outbox_events" FOR INSERT TO svc_definer
  WITH CHECK (event = 'notification.email.requested.v1' AND attempts = 0 AND dispatched_at IS NULL);

-- The comment-notice window looks up recent notices of one link.
CREATE INDEX "notifications_review_comment_window"
  ON "app"."notifications" (workspace_id, (payload ->> 'stagingLinkId'), created_at DESC)
  WHERE type = 'review.client_commented';

-- =============================================================== 5. helpers (callable by their owner only)
-- One system status move with its audit row. Returns true when the project moved; false when it was not in
-- p_from (a member moved it, or it is already further along): the review event is still recorded elsewhere.
CREATE FUNCTION app.review_set_status(p_workspace_id uuid, p_project_id uuid, p_from app.project_status,
                                      p_to app.project_status, p_reason text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM pg_catalog.set_config('app.review_transition', 'on', true);
  UPDATE app.projects SET status = p_to
   WHERE workspace_id = p_workspace_id AND id = p_project_id AND status = p_from AND deleted_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM pg_catalog.set_config('app.review_transition', '', true);
  IF v_count = 0 THEN
    RETURN false;
  END IF;
  INSERT INTO app.audit_logs (workspace_id, project_id, actor_type, actor_id, action, target_type, target_id,
                              result, metadata)
  VALUES (p_workspace_id, p_project_id, 'system', NULL, 'project.status_changed', 'project', p_project_id::text,
          'success', pg_catalog.jsonb_build_object('from', p_from, 'to', p_to, 'reason', p_reason));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.review_set_status(uuid, uuid, app.project_status, app.project_status, text) FROM PUBLIC;

-- Notifies the project's creator (while still a member) and the workspace's owners and admins, each by their
-- choices for the category `project.client_review` (no row: in-app on, e-mail on; module 09). An e-mail is an
-- outbox row the sweep dispatches. Payload values are ids, numbers and codes only. Returns the notices written.
CREATE FUNCTION app.review_notify(p_workspace_id uuid, p_project_id uuid, p_type text, p_payload jsonb)
RETURNS integer
LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
DECLARE
  v_recipient record;
  v_id uuid;
  v_count integer := 0;
BEGIN
  FOR v_recipient IN
    SELECT m.user_id,
           COALESCE(np.in_app, true) AS in_app,
           COALESCE(np.email, true) AS email
      FROM app.memberships m
      JOIN app.projects p ON p.workspace_id = m.workspace_id AND p.id = p_project_id
      LEFT JOIN app.notification_preferences np
        ON np.workspace_id = m.workspace_id AND np.user_id = m.user_id AND np.category = 'project.client_review'
     WHERE m.workspace_id = p_workspace_id
       AND (m.role IN ('owner', 'admin') OR m.user_id = p.created_by)
     ORDER BY m.user_id
  LOOP
    CONTINUE WHEN NOT v_recipient.in_app AND NOT v_recipient.email;
    INSERT INTO app.notifications (workspace_id, user_id, type, payload)
    VALUES (p_workspace_id, v_recipient.user_id, p_type, p_payload)
    RETURNING id INTO v_id;
    v_count := v_count + 1;
    IF v_recipient.email THEN
      INSERT INTO app.outbox_events (workspace_id, event, payload)
      VALUES (p_workspace_id, 'notification.email.requested.v1',
              pg_catalog.jsonb_build_object('workspaceId', p_workspace_id::text, 'notificationId', v_id::text));
    END IF;
  END LOOP;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION app.review_notify(uuid, uuid, text, jsonb) FROM PUBLIC;

-- =============================================================== 6. a new review link: Draft -> In review
-- AFTER INSERT on staging_links, in the member's transaction; SECURITY DEFINER so the move is the system's
-- (decision: "system actor, audited"), whatever the member's role.
CREATE FUNCTION app.staging_links_review_status() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.review_set_status(NEW.workspace_id, NEW.project_id, 'draft', 'in_review', 'review_link_created');
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.staging_links_review_status() FROM PUBLIC;
CREATE TRIGGER staging_links_review_status AFTER INSERT ON "app"."staging_links"
  FOR EACH ROW EXECUTE FUNCTION app.staging_links_review_status();

-- =============================================================== ownership (S1-2: triggers before the transfer)
-- The helpers and the trigger function go to svc_definer (the trigger exists already, so migrator no longer needs
-- EXECUTE). The two S8a visitor functions are owned by svc_definer, so they are replaced as that role.
GRANT CREATE ON SCHEMA "app" TO svc_definer;
ALTER FUNCTION app.review_set_status(uuid, uuid, app.project_status, app.project_status, text) OWNER TO svc_definer;
ALTER FUNCTION app.review_notify(uuid, uuid, text, jsonb) OWNER TO svc_definer;
ALTER FUNCTION app.staging_links_review_status() OWNER TO svc_definer;
SET ROLE svc_definer;

-- =============================================================== 7. add_review_comment (S8a + notice)
-- As in S8a; after the insert, the members are told once per link per 15 minutes (the page counts the comments
-- in the window when it shows the notice). The lock orders concurrent first comments on one link.
CREATE OR REPLACE FUNCTION app.add_review_comment(p_link_id uuid, p_version_id uuid, p_page_id text,
                                                  p_section_id text, p_name text, p_email text, p_body text,
                                                  p_ip_hash text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_target record;
  v_name text := btrim(COALESCE(p_name, ''));
  v_email text := NULLIF(pg_catalog.lower(btrim(COALESCE(p_email, ''))), '');
  v_body text := btrim(COALESCE(p_body, ''));
  v_page text := NULLIF(btrim(COALESCE(p_page_id, '')), '');
  v_section text := NULLIF(btrim(COALESCE(p_section_id, '')), '');
  v_count integer;
BEGIN
  SELECT * INTO v_target FROM app.review_link_target(p_link_id);
  IF v_target.status <> 'ok' THEN
    RETURN v_target.status;
  END IF;
  IF p_version_id IS DISTINCT FROM v_target.site_version_id THEN
    RETURN 'stale';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 80
     OR char_length(v_body) NOT BETWEEN 1 AND 2000
     OR (v_email IS NOT NULL AND (char_length(v_email) > 254
                                  OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'))
     OR (p_ip_hash IS NOT NULL AND p_ip_hash !~ '^[0-9a-f]{32}$')
     OR (v_section IS NOT NULL AND v_page IS NULL) THEN
    RETURN 'invalid';
  END IF;
  IF v_page IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_target.config -> 'pages') pg
        WHERE pg ->> 'id' = v_page
          AND (v_section IS NULL OR EXISTS (
                SELECT 1 FROM jsonb_array_elements(pg -> 'sections') s WHERE s ->> 'id' = v_section))) THEN
    RETURN 'no_section';
  END IF;
  -- Serialise comments on one version so the cap holds under concurrent posts.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('review_comments:' || p_version_id::text, 0));
  SELECT count(*) INTO v_count FROM app.review_comments c
   WHERE c.site_version_id = p_version_id AND c.author_kind = 'client';
  IF v_count >= 300 THEN
    RETURN 'limit';
  END IF;
  INSERT INTO app.review_comments (workspace_id, project_id, site_version_id, staging_link_id, page_id, section_id,
                                   author_kind, author_name, author_email, body, ip_hash)
  VALUES (v_target.workspace_id, v_target.project_id, p_version_id, p_link_id, v_page, v_section,
          'client', v_name, v_email, v_body, p_ip_hash);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('review_notice:' || p_link_id::text, 0));
  IF NOT EXISTS (
       SELECT 1 FROM app.notifications n
        WHERE n.workspace_id = v_target.workspace_id AND n.type = 'review.client_commented'
          AND (n.payload ->> 'stagingLinkId') = p_link_id::text
          AND n.created_at > pg_catalog.now() - interval '15 minutes') THEN
    PERFORM app.review_notify(v_target.workspace_id, v_target.project_id, 'review.client_commented',
                              pg_catalog.jsonb_build_object('projectId', v_target.project_id::text,
                                                            'stagingLinkId', p_link_id::text,
                                                            'versionId', p_version_id::text,
                                                            'number', v_target.version_number::text));
  END IF;
  RETURN 'ok';
END
$$;

-- =============================================================== 8. approve_review_version (S8a + status + notice)
CREATE OR REPLACE FUNCTION app.approve_review_version(p_link_id uuid, p_version_id uuid, p_name text, p_email text,
                                                      p_ip_hash text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_target record;
  v_name text := btrim(COALESCE(p_name, ''));
  v_email text := NULLIF(pg_catalog.lower(btrim(COALESCE(p_email, ''))), '');
  v_id uuid;
BEGIN
  SELECT * INTO v_target FROM app.review_link_target(p_link_id);
  IF v_target.status <> 'ok' THEN
    RETURN v_target.status;
  END IF;
  IF p_version_id IS DISTINCT FROM v_target.site_version_id THEN
    RETURN 'stale';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 80
     OR (v_email IS NOT NULL AND (char_length(v_email) > 254
                                  OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'))
     OR (p_ip_hash IS NOT NULL AND p_ip_hash !~ '^[0-9a-f]{32}$') THEN
    RETURN 'invalid';
  END IF;
  INSERT INTO app.review_approvals (workspace_id, project_id, site_version_id, staging_link_id, approver_name,
                                    approver_email, ip_hash)
  VALUES (v_target.workspace_id, v_target.project_id, p_version_id, p_link_id, v_name, v_email, p_ip_hash)
  ON CONFLICT (workspace_id, staging_link_id, site_version_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN 'already';
  END IF;
  -- Ids and the version number only; the name is in the approval row (data-classification.md).
  INSERT INTO app.audit_logs (workspace_id, project_id, actor_type, actor_id, action, target_type, target_id,
                              result, metadata)
  VALUES (v_target.workspace_id, v_target.project_id, 'client', NULL, 'review.version_approved', 'site_version',
          p_version_id::text, 'success',
          jsonb_build_object('approvalId', v_id, 'stagingLinkId', p_link_id, 'number', v_target.version_number));
  PERFORM app.review_set_status(v_target.workspace_id, v_target.project_id, 'in_review', 'approved',
                                'client_approved');
  PERFORM app.review_notify(v_target.workspace_id, v_target.project_id, 'review.client_approved',
                            pg_catalog.jsonb_build_object('projectId', v_target.project_id::text,
                                                          'stagingLinkId', p_link_id::text,
                                                          'versionId', p_version_id::text,
                                                          'approvalId', v_id::text,
                                                          'number', v_target.version_number::text));
  RETURN 'ok';
END
$$;

RESET ROLE;
REVOKE CREATE ON SCHEMA "app" FROM svc_definer;
