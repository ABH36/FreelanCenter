-- =====================================================================================================
-- P3 S8a: client review (SRS FR-PUB-05; module 06; plan approved by the Owner 2026-11-16).
-- Runs as `migrator` after 20261115210000_p3_s7a_publishing. Forward-only; rollback is a new migration that drops
-- the four visitor functions, the helper, the two tables with their trigger functions and the enum (nothing outside
-- this migration reads them).
--
--   review_comments    SRS ReviewComment. A client comments through a staging link (`/s/<token>/_review`) on the
--                      version the link shows, pinned to a page and a section of that version (or to the whole
--                      site). A member replies to a client comment (decision 4: the client sees the reply) and
--                      marks it resolved. Rows are never deleted (retention with P8).
--   review_approvals   The client's approval of exactly one version through one link (who, when, which version).
--                      Immutable (decision 6: an approval is not withdrawn; a new staging version needs a new one).
--   review_link_target(link)            helper, executable by nobody but its owner: what a link points at now.
--   add_review_comment(...)             app_public: a client comment (validated, capped at 300 per version).
--   approve_review_version(...)         app_public: a client approval, with its audit row (actor_type client).
--   get_review_thread(link, version)    app_public: the comments and replies a link may show (no e-mail, no IP).
--   get_review_approval(link, version)  app_public: the approval of that link and version, if any.
-- Visitor functions are called only after the sites app verified the link's signature and expiry, and they check
-- the link again (revoked, expired, paused or archived project, suspended workspace) before reading or writing.
-- =====================================================================================================

CREATE TYPE "app"."review_author_kind" AS ENUM ('client', 'member');

-- =============================================================== review_comments
CREATE TABLE "app"."review_comments" (
    "id" UUID NOT NULL DEFAULT app.uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_version_id" UUID NOT NULL,
    "staging_link_id" UUID NOT NULL,
    "page_id" TEXT,
    "section_id" TEXT,
    "author_kind" "app"."review_author_kind" NOT NULL,
    "author_name" TEXT,
    "author_email" TEXT,
    "author_user_id" UUID,
    "body" TEXT NOT NULL,
    "parent_id" UUID,
    "ip_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" UUID,

    CONSTRAINT "review_comments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "review_comments_workspace_id_id_key" ON "app"."review_comments"("workspace_id", "id");
CREATE INDEX "review_comments_workspace_id_project_id_created_at_idx"
  ON "app"."review_comments"("workspace_id", "project_id", "created_at" DESC);
CREATE INDEX "review_comments_staging_link_id_site_version_id_created_at_idx"
  ON "app"."review_comments"("staging_link_id", "site_version_id", "created_at");
CREATE INDEX "review_comments_site_version_id_idx" ON "app"."review_comments"("site_version_id");

ALTER TABLE "app"."review_comments"
  ADD CONSTRAINT "review_comments_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "app"."workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "review_comments_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id")
    REFERENCES "app"."projects"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "review_comments_workspace_id_site_version_id_fkey" FOREIGN KEY ("workspace_id", "site_version_id")
    REFERENCES "app"."site_versions"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "review_comments_workspace_id_staging_link_id_fkey" FOREIGN KEY ("workspace_id", "staging_link_id")
    REFERENCES "app"."staging_links"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "review_comments_workspace_id_parent_id_fkey" FOREIGN KEY ("workspace_id", "parent_id")
    REFERENCES "app"."review_comments"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- CHECK passes on NULL, so every boolean below is coalesced (lesson from P3 S6).
  ADD CONSTRAINT "review_comments_body" CHECK (
    COALESCE(char_length(btrim(body)) BETWEEN 1 AND 2000, false)),
  ADD CONSTRAINT "review_comments_pin" CHECK (
    COALESCE(page_id IS NULL OR page_id ~ '^[a-z0-9][a-z0-9-]{0,39}$', false)
    AND COALESCE(section_id IS NULL OR section_id ~ '^[a-z0-9][a-z0-9-]{0,39}$', false)
    AND (section_id IS NULL OR page_id IS NOT NULL)),
  -- A client comment has a name and no member; a member reply has a member, a parent and no client details.
  ADD CONSTRAINT "review_comments_author" CHECK (
    (author_kind = 'client'
      AND COALESCE(char_length(author_name) BETWEEN 1 AND 80, false)
      AND COALESCE(author_email IS NULL OR (char_length(author_email) <= 254
                                            AND author_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'), false)
      AND COALESCE(ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{32}$', false)
      AND author_user_id IS NULL AND parent_id IS NULL)
    OR
    (author_kind = 'member'
      AND author_user_id IS NOT NULL AND parent_id IS NOT NULL
      AND author_name IS NULL AND author_email IS NULL AND ip_hash IS NULL)),
  ADD CONSTRAINT "review_comments_resolution_pair" CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)),
  ADD CONSTRAINT "review_comments_resolution_top_level" CHECK (resolved_at IS NULL OR parent_id IS NULL);

-- The database sets authors and times. A reply takes its project, version, link and pin from its parent, which must
-- be a client comment of the same workspace. Only resolving and reopening a client comment changes a row.
CREATE FUNCTION app.review_comments_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_parent record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := pg_catalog.now();
    NEW.resolved_at := NULL;
    NEW.resolved_by := NULL;
    IF NEW.author_kind = 'member' THEN
      NEW.author_user_id := app.current_actor_user();
      -- A row for another workspace is left to the RLS WITH CHECK (42501).
      IF NEW.workspace_id IS NOT DISTINCT FROM app.current_workspace() THEN
        SELECT c.project_id, c.site_version_id, c.staging_link_id, c.page_id, c.section_id, c.author_kind, c.parent_id
          INTO v_parent
          FROM app.review_comments c
         WHERE c.workspace_id = NEW.workspace_id AND c.id = NEW.parent_id;
        IF NOT FOUND OR v_parent.author_kind <> 'client' OR v_parent.parent_id IS NOT NULL THEN
          RAISE EXCEPTION 'a reply answers a client comment' USING ERRCODE = 'P5103';
        END IF;
        NEW.project_id := v_parent.project_id;
        NEW.site_version_id := v_parent.site_version_id;
        NEW.staging_link_id := v_parent.staging_link_id;
        NEW.page_id := v_parent.page_id;
        NEW.section_id := v_parent.section_id;
      END IF;
    ELSE
      NEW.author_user_id := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.workspace_id, NEW.project_id, NEW.site_version_id, NEW.staging_link_id, NEW.page_id,
      NEW.section_id, NEW.author_kind, NEW.author_name, NEW.author_email, NEW.author_user_id, NEW.body,
      NEW.parent_id, NEW.ip_hash, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.workspace_id, OLD.project_id, OLD.site_version_id, OLD.staging_link_id, OLD.page_id,
      OLD.section_id, OLD.author_kind, OLD.author_name, OLD.author_email, OLD.author_user_id, OLD.body,
      OLD.parent_id, OLD.ip_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'only the resolution of a review comment can change' USING ERRCODE = '42501';
  END IF;
  IF NEW.resolved_at IS NOT NULL THEN
    IF OLD.resolved_at IS NOT NULL THEN
      NEW.resolved_at := OLD.resolved_at;
      NEW.resolved_by := OLD.resolved_by;
    ELSE
      NEW.resolved_at := pg_catalog.now();
      NEW.resolved_by := app.current_actor_user();
    END IF;
  ELSE
    NEW.resolved_by := NULL;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.review_comments_guard() FROM PUBLIC;
CREATE TRIGGER review_comments_guard BEFORE INSERT OR UPDATE ON "app"."review_comments"
  FOR EACH ROW EXECUTE FUNCTION app.review_comments_guard();

CREATE FUNCTION app.review_reject_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION '% cannot be deleted (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END
$$;
REVOKE ALL ON FUNCTION app.review_reject_delete() FROM PUBLIC;
CREATE TRIGGER review_comments_no_delete BEFORE DELETE ON "app"."review_comments"
  FOR EACH ROW EXECUTE FUNCTION app.review_reject_delete();
CREATE TRIGGER review_comments_no_truncate BEFORE TRUNCATE ON "app"."review_comments"
  FOR EACH STATEMENT EXECUTE FUNCTION app.review_reject_delete();

ALTER TABLE "app"."review_comments" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_select ON "app"."review_comments" FOR SELECT TO app_user
  USING (workspace_id = app.current_workspace());
-- Members only reply (decision 4); whoever edits the draft answers the client (owners, admins, editors).
CREATE POLICY editor_insert ON "app"."review_comments" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor')
              AND author_kind = 'member'
              AND app.project_editable(project_id));
CREATE POLICY editor_update ON "app"."review_comments" FOR UPDATE TO app_user
  USING (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
         AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'))
  WITH CHECK (workspace_id = app.current_workspace()
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'));

GRANT SELECT ON "app"."review_comments" TO app_user;
GRANT INSERT (id, workspace_id, project_id, site_version_id, staging_link_id, page_id, section_id, author_kind,
              body, parent_id, created_at) ON "app"."review_comments" TO app_user;
GRANT UPDATE (resolved_at, resolved_by) ON "app"."review_comments" TO app_user;

-- =============================================================== review_approvals
CREATE TABLE "app"."review_approvals" (
    "id" UUID NOT NULL DEFAULT app.uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_version_id" UUID NOT NULL,
    "staging_link_id" UUID NOT NULL,
    "approver_name" TEXT NOT NULL,
    "approver_email" TEXT,
    "ip_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_approvals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "review_approvals_workspace_id_id_key" ON "app"."review_approvals"("workspace_id", "id");
CREATE UNIQUE INDEX "review_approvals_workspace_id_staging_link_id_site_version__key"
  ON "app"."review_approvals"("workspace_id", "staging_link_id", "site_version_id");
CREATE INDEX "review_approvals_workspace_id_project_id_created_at_idx"
  ON "app"."review_approvals"("workspace_id", "project_id", "created_at" DESC);
CREATE INDEX "review_approvals_site_version_id_idx" ON "app"."review_approvals"("site_version_id");

ALTER TABLE "app"."review_approvals"
  ADD CONSTRAINT "review_approvals_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "app"."workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "review_approvals_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id")
    REFERENCES "app"."projects"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "review_approvals_workspace_id_site_version_id_fkey" FOREIGN KEY ("workspace_id", "site_version_id")
    REFERENCES "app"."site_versions"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "review_approvals_workspace_id_staging_link_id_fkey" FOREIGN KEY ("workspace_id", "staging_link_id")
    REFERENCES "app"."staging_links"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "review_approvals_approver" CHECK (
    COALESCE(char_length(approver_name) BETWEEN 1 AND 80, false)
    AND COALESCE(approver_email IS NULL OR (char_length(approver_email) <= 254
                 AND approver_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'), false)
    AND COALESCE(ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{32}$', false));

CREATE FUNCTION app.review_approvals_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'review_approvals are immutable (% rejected)', TG_OP USING ERRCODE = '42501';
END
$$;
REVOKE ALL ON FUNCTION app.review_approvals_guard() FROM PUBLIC;
CREATE TRIGGER review_approvals_guard BEFORE INSERT OR UPDATE ON "app"."review_approvals"
  FOR EACH ROW EXECUTE FUNCTION app.review_approvals_guard();
CREATE TRIGGER review_approvals_no_delete BEFORE DELETE ON "app"."review_approvals"
  FOR EACH ROW EXECUTE FUNCTION app.review_reject_delete();
CREATE TRIGGER review_approvals_no_truncate BEFORE TRUNCATE ON "app"."review_approvals"
  FOR EACH STATEMENT EXECUTE FUNCTION app.review_reject_delete();

ALTER TABLE "app"."review_approvals" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

-- Members read approvals; only the client (through the visitor function) writes one.
CREATE POLICY tenant_select ON "app"."review_approvals" FOR SELECT TO app_user
  USING (workspace_id = app.current_workspace());
GRANT SELECT ON "app"."review_approvals" TO app_user;

-- =============================================================== what the visitor functions read and write
CREATE POLICY definer_select ON "app"."review_comments" FOR SELECT TO svc_definer USING (true);
CREATE POLICY definer_insert ON "app"."review_comments" FOR INSERT TO svc_definer
  WITH CHECK (author_kind = 'client');
CREATE POLICY definer_select ON "app"."review_approvals" FOR SELECT TO svc_definer USING (true);
CREATE POLICY definer_insert ON "app"."review_approvals" FOR INSERT TO svc_definer WITH CHECK (true);
GRANT SELECT (id, workspace_id, project_id, site_version_id, staging_link_id, page_id, section_id, author_kind,
              author_name, body, parent_id, created_at, resolved_at)
  ON "app"."review_comments" TO svc_definer;
GRANT INSERT (workspace_id, project_id, site_version_id, staging_link_id, page_id, section_id, author_kind,
              author_name, author_email, body, ip_hash)
  ON "app"."review_comments" TO svc_definer;
GRANT SELECT (id, workspace_id, project_id, site_version_id, staging_link_id, approver_name, created_at)
  ON "app"."review_approvals" TO svc_definer;
GRANT INSERT (workspace_id, project_id, site_version_id, staging_link_id, approver_name, approver_email, ip_hash)
  ON "app"."review_approvals" TO svc_definer;
-- The approval's version number for its audit row.
GRANT SELECT (number) ON "app"."site_versions" TO svc_definer;

-- =============================================================== review_link_target (helper)
-- What a link points at now: status as app.get_staging_site (ok, revoked, expired, unavailable, unknown) and, for
-- ok, the link's workspace and project and the project's staging version. Not executable by any role: only the
-- visitor functions below (same owner) call it.
CREATE FUNCTION app.review_link_target(p_link_id uuid)
RETURNS TABLE (status text, workspace_id uuid, project_id uuid, site_version_id uuid, version_number integer,
               config jsonb)
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_link record;
  v_version record;
BEGIN
  SELECT l.workspace_id, l.project_id, l.expires_at, l.revoked_at,
         (w.status = 'active' AND w.deleted_at IS NULL AND p.deleted_at IS NULL
          AND p.status NOT IN ('paused', 'archived')) AS servable
    INTO v_link
    FROM app.staging_links l
    JOIN app.workspaces w ON w.id = l.workspace_id
    JOIN app.projects p ON p.workspace_id = l.workspace_id AND p.id = l.project_id
   WHERE l.id = p_link_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unknown'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer, NULL::jsonb;
    RETURN;
  END IF;
  IF v_link.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT 'revoked'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer, NULL::jsonb;
    RETURN;
  END IF;
  IF v_link.expires_at <= pg_catalog.now() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer, NULL::jsonb;
    RETURN;
  END IF;
  IF v_link.servable THEN
    SELECT v.id, v.number, v.config INTO v_version
      FROM app.site_pointers sp
      JOIN app.site_versions v ON v.workspace_id = sp.workspace_id AND v.id = sp.site_version_id
     WHERE sp.workspace_id = v_link.workspace_id AND sp.project_id = v_link.project_id AND sp.kind = 'staging';
    IF FOUND THEN
      RETURN QUERY SELECT 'ok'::text, v_link.workspace_id, v_link.project_id, v_version.id, v_version.number,
                          v_version.config;
      RETURN;
    END IF;
  END IF;
  RETURN QUERY SELECT 'unavailable'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer, NULL::jsonb;
END
$$;
REVOKE ALL ON FUNCTION app.review_link_target(uuid) FROM PUBLIC;

-- =============================================================== add_review_comment
-- One client comment. Answers exactly one word:
--   ok | revoked | expired | unavailable | unknown   (the link, as get_staging_site)
--   stale       the link now shows another version than the one the client commented on (reload and look again)
--   no_section  the page or section is not in that version
--   invalid     name, e-mail, text or IP hash out of bounds
--   limit       the version already has 300 client comments
CREATE FUNCTION app.add_review_comment(p_link_id uuid, p_version_id uuid, p_page_id text, p_section_id text,
                                       p_name text, p_email text, p_body text, p_ip_hash text)
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
  RETURN 'ok';
END
$$;
REVOKE ALL ON FUNCTION app.add_review_comment(uuid, uuid, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_review_comment(uuid, uuid, text, text, text, text, text, text) TO app_public;

-- =============================================================== approve_review_version
-- The client approves the version the link shows. Answers ok (recorded now, with an audit row), already (this link
-- already approved this version; nothing written), or the link / stale / invalid words of add_review_comment.
CREATE FUNCTION app.approve_review_version(p_link_id uuid, p_version_id uuid, p_name text, p_email text,
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
  RETURN 'ok';
END
$$;
REVOKE ALL ON FUNCTION app.approve_review_version(uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.approve_review_version(uuid, uuid, text, text, text) TO app_public;

-- =============================================================== get_review_thread
-- The comments of one link on one version and the members' replies to them, oldest first, at most 600. No e-mail,
-- no IP hash and no member identity (the page names the workspace). Nothing for a link that may not show now.
CREATE FUNCTION app.get_review_thread(p_link_id uuid, p_version_id uuid)
RETURNS TABLE (id uuid, parent_id uuid, page_id text, section_id text, author_kind text, author_name text,
               body text, created_at timestamptz, resolved boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_target record;
BEGIN
  SELECT * INTO v_target FROM app.review_link_target(p_link_id);
  IF v_target.status <> 'ok' THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT c.id, c.parent_id, c.page_id, c.section_id, c.author_kind::text, c.author_name, c.body, c.created_at,
           c.resolved_at IS NOT NULL
      FROM app.review_comments c
     WHERE c.workspace_id = v_target.workspace_id AND c.staging_link_id = p_link_id
       AND c.site_version_id = p_version_id
     ORDER BY c.created_at, c.id
     LIMIT 600;
END
$$;
REVOKE ALL ON FUNCTION app.get_review_thread(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.get_review_thread(uuid, uuid) TO app_public;

-- =============================================================== get_review_approval
CREATE FUNCTION app.get_review_approval(p_link_id uuid, p_version_id uuid)
RETURNS TABLE (approver_name text, approved_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_target record;
BEGIN
  SELECT * INTO v_target FROM app.review_link_target(p_link_id);
  IF v_target.status <> 'ok' THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT a.approver_name, a.created_at
      FROM app.review_approvals a
     WHERE a.workspace_id = v_target.workspace_id AND a.staging_link_id = p_link_id
       AND a.site_version_id = p_version_id;
END
$$;
REVOKE ALL ON FUNCTION app.get_review_approval(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.get_review_approval(uuid, uuid) TO app_public;

-- =============================================================== ownership (S1-2: EXECUTE before the transfer)
GRANT CREATE ON SCHEMA "app" TO svc_definer;
ALTER FUNCTION app.review_link_target(uuid) OWNER TO svc_definer;
ALTER FUNCTION app.add_review_comment(uuid, uuid, text, text, text, text, text, text) OWNER TO svc_definer;
ALTER FUNCTION app.approve_review_version(uuid, uuid, text, text, text) OWNER TO svc_definer;
ALTER FUNCTION app.get_review_thread(uuid, uuid) OWNER TO svc_definer;
ALTER FUNCTION app.get_review_approval(uuid, uuid) OWNER TO svc_definer;
REVOKE CREATE ON SCHEMA "app" FROM svc_definer;
