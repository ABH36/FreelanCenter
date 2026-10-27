-- =====================================================================================================
-- P1 S8: admin console v0 (FR-ADM-01 basic, FR-ADM-02 workspace, SEC-17). Runs as `migrator` after
-- 20261026120000_p1_s7_host_routing.
--
-- `app_admin` (DATABASE_URL_ADMIN) still holds no table privilege. Everything the console does goes through the
-- SECURITY DEFINER functions below, and every one of them re-checks in the database, on every call, that the
-- caller is
--   1. an active platform admin (app.platform_admins, not revoked; identity user active),
--   2. with TOTP enrolled (identity.users.two_factor_enabled),
--   3. on a live Better Auth session of that user (identity.sessions, not expired, so a revoked session is dead),
--   4. that passed the console's TOTP step-up within the last 15 minutes (app.admin_step_ups, bound to that
--      session).
-- The dashboard verifies the TOTP code itself (Better Auth decrypts the secret); the database records the
-- attempt, enforces the lockout (5 failed or abandoned attempts per 15 minutes) and audits it.
--
-- Data minimisation (module 03: "admin search must not bypass data minimization"): no function returns a person's
-- name, a full e-mail address in a list, client contacts, project names, IP addresses or user agents; e-mail
-- search is by exact address only (no fragment enumeration); every search and every workspace view is audited
-- with the kind and length of the query, never its text.
--
-- `admin_set_workspace_status` gains the session argument and, in the same transaction, writes one
-- `sites.hosts.changed.v1` outbox row per project of the workspace (S7 decision D12), so apps/sites drops its
-- cached answers at once instead of after the 300 s TTL. The old five-argument signature is dropped: only
-- tests and the operator runbook called it.
--
-- Platform audit rows (workspace_id NULL) become readable for the first time, to platform admins only, through
-- `admin_list_audit` (with every row written by an admin, whatever its workspace).
-- =====================================================================================================

-- ---------------------------------------------------------------- 1. step-up attempts
CREATE TYPE "app"."admin_step_up_status" AS ENUM ('pending', 'failed', 'verified');

CREATE TABLE "app"."admin_step_ups" (
    "id" UUID NOT NULL DEFAULT app.uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "status" "app"."admin_step_up_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "admin_step_ups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_step_ups_user_id_created_at_idx" ON "app"."admin_step_ups"("user_id", "created_at" DESC);

ALTER TABLE "app"."admin_step_ups" ADD CONSTRAINT "admin_step_ups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."platform_admins"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A verified attempt always has both times, and only a verified one has them.
ALTER TABLE "app"."admin_step_ups"
  ADD CONSTRAINT "admin_step_ups_verified_times" CHECK (
    (status = 'verified') = (verified_at IS NOT NULL AND expires_at IS NOT NULL)
    AND (expires_at IS NULL OR expires_at > verified_at)
  );

-- No application role has a grant or a policy; svc_definer's policies are in section 4.
ALTER TABLE "app"."admin_step_ups" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

-- The admin audit viewer pages platform rows and admin-written rows newest first.
CREATE INDEX "audit_logs_platform_view" ON "app"."audit_logs" (id DESC)
  WHERE workspace_id IS NULL OR actor_type = 'platform_admin';

-- ---------------------------------------------------------------- 2. internal checks (not executable by any app role)
-- Plain (invoker) functions owned by svc_definer: they run with the privileges of the definer function that calls
-- them, and no application role can call them directly.

-- Conditions 1-3 of the header.
CREATE FUNCTION app.admin_session_valid(p_user_id uuid, p_session_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.platform_admins a
      JOIN identity.users u ON u.id = a.user_id
      JOIN identity.sessions s ON s.user_id = u.id
     WHERE a.user_id = p_user_id AND a.revoked_at IS NULL
       AND u.status = 'active' AND u.two_factor_enabled IS TRUE
       AND s.id = p_session_id AND s.expires_at > pg_catalog.now()
  )
$$;

-- Condition 4 on top: the end of the current step-up of this session, or NULL.
CREATE FUNCTION app.admin_step_up_until(p_user_id uuid, p_session_id uuid) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT pg_catalog.max(t.expires_at) FROM app.admin_step_ups t
   WHERE t.user_id = p_user_id AND t.session_id = p_session_id AND t.status = 'verified'
     AND t.expires_at > pg_catalog.now()
$$;

-- When the lockout ends, or NULL: five failed or abandoned (pending) attempts within 15 minutes since the last
-- verified one lock further attempts until the oldest of those five is 15 minutes old.
CREATE FUNCTION app.admin_step_up_locked_until(p_user_id uuid) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT f.created_at + interval '15 minutes' FROM app.admin_step_ups f
   WHERE f.user_id = p_user_id AND f.status IN ('pending', 'failed')
     AND f.created_at > pg_catalog.now() - interval '15 minutes'
     AND f.created_at > COALESCE((SELECT pg_catalog.max(v.verified_at) FROM app.admin_step_ups v
                                   WHERE v.user_id = p_user_id AND v.status = 'verified'), '-infinity')
   ORDER BY f.created_at DESC
  OFFSET 4 LIMIT 1
$$;

-- Every console function starts with this: all four conditions, or 42501.
CREATE FUNCTION app.admin_require(p_user_id uuid, p_session_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF NOT app.admin_session_valid(p_user_id, p_session_id) THEN
    RAISE EXCEPTION 'not an active platform admin with MFA on a live session' USING ERRCODE = '42501';
  END IF;
  IF app.admin_step_up_until(p_user_id, p_session_id) IS NULL THEN
    RAISE EXCEPTION 'admin step-up required' USING ERRCODE = '42501';
  END IF;
END
$$;

-- A platform audit row written by an admin (workspace_id NULL unless a workspace is given).
CREATE FUNCTION app.admin_audit(
  p_admin_user_id uuid, p_workspace_id uuid, p_action text, p_target_type text, p_target_id text,
  p_result app.audit_result, p_correlation_id text, p_metadata jsonb
) RETURNS void
LANGUAGE sql VOLATILE SET search_path = '' AS $$
  INSERT INTO app.audit_logs (id, workspace_id, actor_type, actor_id, action, target_type, target_id, result,
                              correlation_id, metadata)
  VALUES (app.uuid_generate_v7(), p_workspace_id, 'platform_admin', p_admin_user_id, p_action, p_target_type,
          p_target_id, p_result, pg_catalog.left(p_correlation_id, 128), COALESCE(p_metadata, '{}'::jsonb))
$$;

-- Masked address for lists: first character of the local part, then the domain (`a***@example.com`).
CREATE FUNCTION app.mask_email(p_email text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN pg_catalog.strpos(p_email, '@') > 1
              THEN pg_catalog.left(p_email, 1) || '***@' || pg_catalog.split_part(p_email, '@', 2)
              ELSE '***' END
$$;

-- What a search query is, for the audit row (never the query itself).
CREATE FUNCTION app.admin_query_kind(p_query text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
           WHEN p_query IS NULL OR p_query = '' THEN 'none'
           WHEN p_query ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN 'id'
           WHEN pg_catalog.strpos(p_query, '@') > 0 THEN 'email'
           ELSE 'text'
         END
$$;

-- ---------------------------------------------------------------- 3. console functions (app_admin)

-- The guard: may this session use the console, and is it stepped up? Never raises for a non-admin (the
-- dashboard answers 404, so the console's existence is not confirmed).
CREATE FUNCTION app.admin_console_state(p_user_id uuid, p_session_id uuid)
RETURNS TABLE (is_admin boolean, step_up_until timestamptz, locked_until timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.admin_session_valid(p_user_id, p_session_id) THEN
    RETURN QUERY SELECT false, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, app.admin_step_up_until(p_user_id, p_session_id), app.admin_step_up_locked_until(p_user_id);
END
$$;

-- Starts one step-up attempt before the code is checked, so an attempt that never finishes still counts. Returns
-- the attempt id, or NULL while locked (the refusal is audited).
CREATE FUNCTION app.admin_step_up_begin(p_user_id uuid, p_session_id uuid, p_correlation_id text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT app.admin_session_valid(p_user_id, p_session_id) THEN
    RAISE EXCEPTION 'not an active platform admin with MFA on a live session' USING ERRCODE = '42501';
  END IF;
  -- Serialises one admin's attempts, so parallel requests cannot all pass the lockout check.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('admin_step_up:' || p_user_id::text, 0));
  IF app.admin_step_up_locked_until(p_user_id) IS NOT NULL THEN
    PERFORM app.admin_audit(p_user_id, NULL, 'admin.step_up.locked', 'user', p_user_id::text, 'denied',
                            p_correlation_id, NULL);
    RETURN NULL;
  END IF;
  INSERT INTO app.admin_step_ups (id, user_id, session_id, status)
  VALUES (app.uuid_generate_v7(), p_user_id, p_session_id, 'pending')
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- Records the result of the code check of a pending attempt (at most 5 minutes old, same admin and session).
-- Returns the end of the step-up when verified, NULL when the code was wrong. Both outcomes are audited.
CREATE FUNCTION app.admin_step_up_finish(
  p_user_id uuid, p_session_id uuid, p_attempt_id uuid, p_verified boolean, p_correlation_id text
) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_until timestamptz;
BEGIN
  IF NOT app.admin_session_valid(p_user_id, p_session_id) THEN
    RAISE EXCEPTION 'not an active platform admin with MFA on a live session' USING ERRCODE = '42501';
  END IF;
  IF p_verified IS TRUE THEN
    UPDATE app.admin_step_ups
       SET status = 'verified', verified_at = pg_catalog.now(), expires_at = pg_catalog.now() + interval '15 minutes'
     WHERE id = p_attempt_id AND user_id = p_user_id AND session_id = p_session_id AND status = 'pending'
       AND created_at > pg_catalog.now() - interval '5 minutes'
    RETURNING expires_at INTO v_until;
  ELSE
    UPDATE app.admin_step_ups SET status = 'failed'
     WHERE id = p_attempt_id AND user_id = p_user_id AND session_id = p_session_id AND status = 'pending'
       AND created_at > pg_catalog.now() - interval '5 minutes';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no pending step-up attempt' USING ERRCODE = 'P0002';
  END IF;
  PERFORM app.admin_audit(p_user_id, NULL,
                          CASE WHEN p_verified IS TRUE THEN 'admin.step_up.verified' ELSE 'admin.step_up.failed' END,
                          'user', p_user_id::text,
                          CASE WHEN p_verified IS TRUE THEN 'success' ELSE 'failure' END::app.audit_result,
                          p_correlation_id, pg_catalog.jsonb_build_object('method', 'totp'));
  RETURN v_until;
END
$$;

-- FR-ADM-01 (workspaces). Query: empty (browse), a workspace id, or text matched against the slug (prefix) and the
-- name (substring, case-insensitive; LIKE wildcards are literal). Newest first, keyset-paged on the id.
CREATE FUNCTION app.admin_list_workspaces(
  p_user_id uuid, p_session_id uuid, p_query text, p_status app.workspace_status, p_before uuid, p_limit integer,
  p_correlation_id text
)
RETURNS TABLE (id uuid, name text, slug text, status app.workspace_status, suspended_at timestamptz,
               deletion_scheduled boolean, created_at timestamptz, member_count integer, project_count integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_query text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_query, '')));
  v_kind text;
  v_like text;
BEGIN
  PERFORM app.admin_require(p_user_id, p_session_id);
  IF pg_catalog.char_length(v_query) > 100 THEN
    RAISE EXCEPTION 'query too long' USING ERRCODE = '22023';
  END IF;
  v_kind := app.admin_query_kind(v_query);
  v_like := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');
  IF v_kind <> 'none' THEN
    PERFORM app.admin_audit(p_user_id, NULL, 'admin.workspaces.searched', NULL, NULL, 'success', p_correlation_id,
      pg_catalog.jsonb_build_object('query_kind', v_kind, 'query_length', pg_catalog.char_length(v_query),
                                    'status', p_status));
  END IF;
  RETURN QUERY
    SELECT w.id, w.name, w.slug, w.status, w.suspended_at, w.deleted_at IS NOT NULL, w.created_at,
           (SELECT pg_catalog.count(*)::integer FROM app.memberships m WHERE m.workspace_id = w.id),
           (SELECT pg_catalog.count(*)::integer FROM app.projects p WHERE p.workspace_id = w.id AND p.deleted_at IS NULL)
      FROM app.workspaces w
     WHERE (p_status IS NULL OR w.status = p_status)
       AND (p_before IS NULL OR w.id < p_before)
       AND CASE v_kind
             WHEN 'none' THEN true
             WHEN 'id' THEN w.id = v_query::uuid
             ELSE w.slug LIKE v_like || '%' OR pg_catalog.lower(w.name) LIKE '%' || v_like || '%'
           END
     ORDER BY w.id DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
END
$$;

-- One workspace for the suspend decision: its state and reason, its owners (id and masked address), and its
-- projects as status + public host names only (no project names, no client data). Audited as a view.
CREATE FUNCTION app.admin_get_workspace(p_user_id uuid, p_session_id uuid, p_workspace_id uuid, p_correlation_id text)
RETURNS TABLE (id uuid, name text, slug text, status app.workspace_status, suspended_at timestamptz,
               suspended_reason text, deletion_scheduled_at timestamptz, created_at timestamptz,
               member_count integer, owners jsonb, projects jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  PERFORM app.admin_require(p_user_id, p_session_id);
  IF NOT EXISTS (SELECT 1 FROM app.workspaces w WHERE w.id = p_workspace_id) THEN
    RETURN;
  END IF;
  PERFORM app.admin_audit(p_user_id, NULL, 'admin.workspace.viewed', 'workspace', p_workspace_id::text, 'success',
                          p_correlation_id, NULL);
  RETURN QUERY
    SELECT w.id, w.name, w.slug, w.status, w.suspended_at, w.suspended_reason, w.scheduled_purge_at, w.created_at,
           (SELECT pg_catalog.count(*)::integer FROM app.memberships m WHERE m.workspace_id = w.id),
           COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                              'userId', m.user_id, 'email', app.mask_email(u.email)) ORDER BY m.created_at)
                       FROM app.memberships m JOIN identity.users u ON u.id = m.user_id
                      WHERE m.workspace_id = w.id AND m.role = 'owner'), '[]'::jsonb),
           COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                              'id', p.id, 'status', p.status,
                              'hosts', COALESCE((SELECT pg_catalog.jsonb_agg(d.hostname ORDER BY d.hostname)
                                                   FROM app.domains d
                                                  WHERE d.workspace_id = p.workspace_id AND d.project_id = p.id
                                                    AND d.deleted_at IS NULL), '[]'::jsonb))
                              ORDER BY p.id DESC)
                       FROM (SELECT p0.id, p0.workspace_id, p0.status FROM app.projects p0
                              WHERE p0.workspace_id = w.id AND p0.deleted_at IS NULL
                              ORDER BY p0.id DESC LIMIT 200) p), '[]'::jsonb)
      FROM app.workspaces w
     WHERE w.id = p_workspace_id;
END
$$;

-- FR-ADM-01 (users). Query: empty (browse), a user id, or one exact e-mail address (no fragments). Addresses are
-- masked in the result; names are not returned.
CREATE FUNCTION app.admin_list_users(
  p_user_id uuid, p_session_id uuid, p_query text, p_before uuid, p_limit integer, p_correlation_id text
)
RETURNS TABLE (id uuid, email_masked text, status identity.user_status, email_verified boolean,
               two_factor_enabled boolean, created_at timestamptz, workspace_count integer, platform_admin boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_query text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_query, '')));
  v_kind text;
BEGIN
  PERFORM app.admin_require(p_user_id, p_session_id);
  IF pg_catalog.char_length(v_query) > 254 THEN
    RAISE EXCEPTION 'query too long' USING ERRCODE = '22023';
  END IF;
  v_kind := app.admin_query_kind(v_query);
  IF v_kind = 'text' THEN
    RAISE EXCEPTION 'search users by id or exact e-mail address' USING ERRCODE = '22023';
  END IF;
  IF v_kind <> 'none' THEN
    PERFORM app.admin_audit(p_user_id, NULL, 'admin.users.searched', NULL, NULL, 'success', p_correlation_id,
      pg_catalog.jsonb_build_object('query_kind', v_kind, 'query_length', pg_catalog.char_length(v_query)));
  END IF;
  RETURN QUERY
    SELECT u.id, app.mask_email(u.email), u.status, u.email_verified, COALESCE(u.two_factor_enabled, false),
           u.created_at,
           (SELECT pg_catalog.count(*)::integer FROM app.memberships m WHERE m.user_id = u.id),
           EXISTS (SELECT 1 FROM app.platform_admins a WHERE a.user_id = u.id AND a.revoked_at IS NULL)
      FROM identity.users u
     WHERE (p_before IS NULL OR u.id < p_before)
       AND CASE v_kind
             WHEN 'none' THEN true
             WHEN 'id' THEN u.id = v_query::uuid
             ELSE u.email = v_query
           END
     ORDER BY u.id DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
END
$$;

-- Admin audit viewer: platform rows (workspace_id NULL: sign-in, sessions, step-ups, searches, operator grants) and
-- every row an admin wrote in any workspace. IP and user agent are not returned. Reading is not audited.
CREATE FUNCTION app.admin_list_audit(
  p_user_id uuid, p_session_id uuid, p_action_prefix text, p_actor_id uuid, p_before uuid, p_limit integer
)
RETURNS TABLE (id uuid, created_at timestamptz, workspace_id uuid, actor_type app.audit_actor_type, actor_id uuid,
               action text, target_type text, target_id text, result app.audit_result, correlation_id text,
               metadata jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  PERFORM app.admin_require(p_user_id, p_session_id);
  IF p_action_prefix IS NOT NULL AND p_action_prefix !~ '^[a-z][a-z0-9_.]{0,99}$' THEN
    RAISE EXCEPTION 'invalid action filter' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT l.id, l.created_at, l.workspace_id, l.actor_type, l.actor_id, l.action, l.target_type, l.target_id,
           l.result, l.correlation_id, l.metadata
      FROM app.audit_logs l
     WHERE (l.workspace_id IS NULL OR l.actor_type = 'platform_admin')
       AND (p_action_prefix IS NULL OR pg_catalog.starts_with(l.action, p_action_prefix))
       AND (p_actor_id IS NULL OR l.actor_id = p_actor_id)
       AND (p_before IS NULL OR l.id < p_before)
     ORDER BY l.id DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
END
$$;

-- Suspend / unsuspend (FR-WS-04, FR-ADM-02, SEC-17). Replaces the S1 function: the caller must now hold a stepped-up
-- admin session, and the change writes one `sites.hosts.changed.v1` outbox row per project of the workspace in the
-- same transaction (S7 D12). Returns whether the status changed and the outbox ids to dispatch after commit;
-- an unchanged status writes nothing (idempotent).
DROP FUNCTION app.admin_set_workspace_status(uuid, uuid, app.workspace_status, text, text);

CREATE FUNCTION app.admin_set_workspace_status(
  p_admin_user_id uuid, p_admin_session_id uuid, p_workspace_id uuid, p_status app.workspace_status, p_reason text,
  p_correlation_id text
) RETURNS TABLE (changed boolean, outbox_ids uuid[])
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_previous app.workspace_status;
  v_ids uuid[];
BEGIN
  IF p_reason IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'a reason of 3 to 500 characters is required' USING ERRCODE = '22023';
  END IF;
  PERFORM app.admin_require(p_admin_user_id, p_admin_session_id);

  SELECT w.status INTO v_previous FROM app.workspaces w WHERE w.id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_previous = p_status THEN
    RETURN QUERY SELECT false, ARRAY[]::uuid[];
    RETURN;
  END IF;

  UPDATE app.workspaces
     SET status = p_status,
         suspended_at = CASE WHEN p_status = 'suspended' THEN pg_catalog.now() END,
         suspended_reason = CASE WHEN p_status = 'suspended' THEN pg_catalog.btrim(p_reason) END,
         updated_at = pg_catalog.now()
   WHERE id = p_workspace_id;

  WITH emitted AS (
    INSERT INTO app.outbox_events (id, workspace_id, event, payload)
    SELECT app.uuid_generate_v7(), p.workspace_id, 'sites.hosts.changed.v1',
           pg_catalog.jsonb_build_object('workspaceId', p.workspace_id, 'projectId', p.id)
      FROM app.projects p
     WHERE p.workspace_id = p_workspace_id AND p.deleted_at IS NULL
    RETURNING id
  )
  SELECT COALESCE(pg_catalog.array_agg(e.id), ARRAY[]::uuid[]) INTO v_ids FROM emitted e;

  PERFORM app.admin_audit(p_admin_user_id, p_workspace_id,
    CASE WHEN p_status = 'suspended' THEN 'admin.workspace.suspended' ELSE 'admin.workspace.unsuspended' END,
    'workspace', p_workspace_id::text, 'success', p_correlation_id,
    pg_catalog.jsonb_build_object('reason', pg_catalog.btrim(p_reason), 'previous_status', v_previous,
                                  'projects', pg_catalog.cardinality(v_ids)));
  RETURN QUERY SELECT true, v_ids;
END
$$;

-- ---------------------------------------------------------------- 4. what svc_definer additionally may touch
GRANT SELECT (id, user_id, session_id, status, created_at, verified_at, expires_at) ON "app"."admin_step_ups" TO svc_definer;
GRANT INSERT (id, user_id, session_id, status) ON "app"."admin_step_ups" TO svc_definer;
GRANT UPDATE (status, verified_at, expires_at) ON "app"."admin_step_ups" TO svc_definer;
CREATE POLICY definer_select ON "app"."admin_step_ups" FOR SELECT TO svc_definer USING (true);
CREATE POLICY definer_insert ON "app"."admin_step_ups" FOR INSERT TO svc_definer WITH CHECK (status = 'pending');
CREATE POLICY definer_update ON "app"."admin_step_ups" FOR UPDATE TO svc_definer USING (status = 'pending')
  WITH CHECK (status IN ('failed', 'verified'));

GRANT SELECT (id, user_id, expires_at) ON "identity"."sessions" TO svc_definer;
GRANT SELECT (created_at) ON "identity"."users" TO svc_definer;
GRANT SELECT (suspended_at, suspended_reason, scheduled_purge_at, created_at) ON "app"."workspaces" TO svc_definer;
-- Platform rows and admin-written rows only; tenant rows of other actors stay invisible to the definer too.
GRANT SELECT (id, created_at, workspace_id, actor_type, actor_id, action, target_type, target_id, result,
  correlation_id, metadata) ON "app"."audit_logs" TO svc_definer;
CREATE POLICY definer_select_platform ON "app"."audit_logs" FOR SELECT TO svc_definer
  USING (workspace_id IS NULL OR actor_type = 'platform_admin');
-- The suspension's host-cache invalidation rows, fresh and of that one event only.
GRANT INSERT (id, workspace_id, event, payload) ON "app"."outbox_events" TO svc_definer;
CREATE POLICY definer_insert ON "app"."outbox_events" FOR INSERT TO svc_definer
  WITH CHECK (event = 'sites.hosts.changed.v1' AND attempts = 0 AND dispatched_at IS NULL);

-- ---------------------------------------------------------------- 5. EXECUTE and ownership
-- EXECUTE before the ownership transfer (S1-2). The helpers are executable by nobody but their owner.
REVOKE ALL ON FUNCTION app.admin_session_valid(uuid, uuid), app.admin_step_up_until(uuid, uuid),
  app.admin_step_up_locked_until(uuid), app.admin_require(uuid, uuid),
  app.admin_audit(uuid, uuid, text, text, text, app.audit_result, text, jsonb), app.mask_email(text),
  app.admin_query_kind(text), app.admin_console_state(uuid, uuid), app.admin_step_up_begin(uuid, uuid, text),
  app.admin_step_up_finish(uuid, uuid, uuid, boolean, text),
  app.admin_list_workspaces(uuid, uuid, text, app.workspace_status, uuid, integer, text),
  app.admin_get_workspace(uuid, uuid, uuid, text), app.admin_list_users(uuid, uuid, text, uuid, integer, text),
  app.admin_list_audit(uuid, uuid, text, uuid, uuid, integer),
  app.admin_set_workspace_status(uuid, uuid, uuid, app.workspace_status, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admin_console_state(uuid, uuid), app.admin_step_up_begin(uuid, uuid, text),
  app.admin_step_up_finish(uuid, uuid, uuid, boolean, text),
  app.admin_list_workspaces(uuid, uuid, text, app.workspace_status, uuid, integer, text),
  app.admin_get_workspace(uuid, uuid, uuid, text), app.admin_list_users(uuid, uuid, text, uuid, integer, text),
  app.admin_list_audit(uuid, uuid, text, uuid, uuid, integer),
  app.admin_set_workspace_status(uuid, uuid, uuid, app.workspace_status, text, text) TO app_admin;

GRANT CREATE ON SCHEMA "app" TO svc_definer;
ALTER FUNCTION app.admin_session_valid(uuid, uuid) OWNER TO svc_definer;
ALTER FUNCTION app.admin_step_up_until(uuid, uuid) OWNER TO svc_definer;
ALTER FUNCTION app.admin_step_up_locked_until(uuid) OWNER TO svc_definer;
ALTER FUNCTION app.admin_require(uuid, uuid) OWNER TO svc_definer;
ALTER FUNCTION app.admin_audit(uuid, uuid, text, text, text, app.audit_result, text, jsonb) OWNER TO svc_definer;
ALTER FUNCTION app.mask_email(text) OWNER TO svc_definer;
ALTER FUNCTION app.admin_query_kind(text) OWNER TO svc_definer;
ALTER FUNCTION app.admin_console_state(uuid, uuid) OWNER TO svc_definer;
ALTER FUNCTION app.admin_step_up_begin(uuid, uuid, text) OWNER TO svc_definer;
ALTER FUNCTION app.admin_step_up_finish(uuid, uuid, uuid, boolean, text) OWNER TO svc_definer;
ALTER FUNCTION app.admin_list_workspaces(uuid, uuid, text, app.workspace_status, uuid, integer, text) OWNER TO svc_definer;
ALTER FUNCTION app.admin_get_workspace(uuid, uuid, uuid, text) OWNER TO svc_definer;
ALTER FUNCTION app.admin_list_users(uuid, uuid, text, uuid, integer, text) OWNER TO svc_definer;
ALTER FUNCTION app.admin_list_audit(uuid, uuid, text, uuid, uuid, integer) OWNER TO svc_definer;
ALTER FUNCTION app.admin_set_workspace_status(uuid, uuid, uuid, app.workspace_status, text, text) OWNER TO svc_definer;
REVOKE CREATE ON SCHEMA "app" FROM svc_definer;
