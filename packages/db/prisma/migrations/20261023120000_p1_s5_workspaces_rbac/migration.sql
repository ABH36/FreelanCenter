-- =====================================================================================================
-- P1 S5: workspaces, membership, RBAC and invitations (SRS 5.1, 5.3, 6.1-6.2, 7; FR-WS-01/02/03, FR-WS-05 hook,
-- FR-AUTH-05/06/08, SEC-10). Runs as `migrator` after 20261022140000_p1_foundation.
--
-- Section map: 1 reserved slugs - 2 role helpers - 3 memberships (role-aware policies, owner guard, last owner)
-- 4 workspaces (manager-only settings, owner-only deletion request) - 5 invitations - 6 SECURITY DEFINER
-- functions (accept, preview, member directory) - 7 privileges and ownership.
--
-- The service layer (`@platform/workspaces`) authorizes every command with `authorize()` first; the policies and
-- triggers below repeat the member-management rules in the database (SEC-10: data layer, not only UI), so a
-- bug in a service cannot let an editor change roles or an admin touch an owner. Every RLS change has a
-- matching test in packages/db/test/integration (SRS 11.2).
-- =====================================================================================================

-- ---------------------------------------------------------------- 1. reserved slugs (FR-WS-01, FR-WS-03)
-- One list for workspace slugs (dashboard routes) and, from S6, platform subdomain labels (Q9). It must equal
-- RESERVED_SLUGS in packages/workspaces/src/slug.ts (asserted by the integration suite). Exact matches only;
-- the keyword/substring anti-phishing blocklist is FR-ABU-02 (P3/P8).
CREATE FUNCTION app.reserved_slugs() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT ARRAY[
    -- infrastructure and mail host names
    'www', 'www1', 'www2', 'app', 'apps', 'api', 'apis', 'admin', 'administrator', 'root', 'mail', 'email',
    'smtp', 'imap', 'pop3', 'webmail', 'mailbox', 'ftp', 'sftp', 'ssh', 'vpn', 'dns', 'ns1', 'ns2', 'ns3',
    'cdn', 'static', 'assets', 'media', 'img', 'images', 'files', 'uploads', 'download', 'downloads',
    'dashboard', 'console', 'portal', 'preview', 'staging', 'stage', 'dev', 'development', 'test', 'testing',
    'demo', 'sandbox', 'beta', 'alpha', 'internal', 'intranet', 'local', 'localhost', 'status', 'health',
    'metrics', 'monitor', 'system', 'null', 'undefined',
    -- product routes and account flows
    'auth', 'login', 'logout', 'signin', 'signout', 'signup', 'sign-in', 'sign-out', 'sign-up', 'register',
    'account', 'accounts', 'billing', 'pay', 'payment', 'payments', 'checkout', 'invoice', 'invoices',
    'settings', 'profile', 'security', 'support', 'help', 'helpdesk', 'docs', 'documentation', 'blog', 'news',
    'about', 'contact', 'legal', 'privacy', 'terms', 'tos', 'abuse', 'report', 'postmaster', 'hostmaster',
    'webmaster', 'noreply', 'no-reply', 'info', 'sales', 'marketing', 'careers', 'jobs', 'press', 'team',
    'store', 'shop', 'marketplace', 'template', 'templates', 'site', 'sites', 'domain', 'domains',
    'workspace', 'workspaces', 'project', 'projects', 'invite', 'invites', 'invitation', 'invitations',
    'oauth', 'sso', 'saml', 'webhook', 'webhooks', 'inngest', 'cron', 'new', 'edit', 'create', 'delete',
    -- our own brand (working name, D1) and frequently impersonated brands
    'platform', 'freelancenter', 'google', 'gmail', 'youtube', 'facebook', 'meta', 'instagram', 'whatsapp',
    'apple', 'icloud', 'microsoft', 'outlook', 'office', 'amazon', 'aws', 'paypal', 'paytm', 'phonepe',
    'gpay', 'razorpay', 'stripe', 'visa', 'mastercard', 'rupay', 'upi', 'sbi', 'hdfc', 'icici', 'irctc',
    'uidai', 'aadhaar', 'incometax', 'gov', 'govt', 'vercel', 'supabase', 'cloudflare', 'github'
  ]::text[]
$$;

CREATE FUNCTION app.is_reserved_slug(p_slug text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT p_slug = ANY (app.reserved_slugs())
$$;

ALTER TABLE "app"."workspaces"
  ADD CONSTRAINT "workspaces_slug_not_reserved" CHECK (NOT app.is_reserved_slug(slug));

-- ---------------------------------------------------------------- 2. role helpers
-- The acting user's role in the current workspace, or NULL (no context, no actor, not a member). SECURITY DEFINER
-- because the membership policies below call it: an invoker function would recurse into those same policies.
CREATE FUNCTION app.current_member_role() RETURNS app.member_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT m.role FROM app.memberships m
   WHERE m.workspace_id = app.current_workspace() AND m.user_id = app.current_actor_user()
$$;

-- True once the current workspace has any member. Until then (inside `withNewWorkspace` only: no other path sets
-- the context to a workspace without members) the creator may insert their own owner membership.
CREATE FUNCTION app.workspace_has_members() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM app.memberships m WHERE m.workspace_id = app.current_workspace())
$$;

-- ---------------------------------------------------------------- 3. memberships (SRS 7: manage members)
-- Writes need an owner or admin of the workspace. Exceptions: the creator's own first owner row (bootstrap),
-- and any member removing their own membership (leave). Reads are unchanged (tenant_select + self_select).
DROP POLICY tenant_insert ON "app"."memberships";
DROP POLICY tenant_update ON "app"."memberships";
DROP POLICY tenant_delete ON "app"."memberships";
CREATE POLICY manager_insert ON "app"."memberships" FOR INSERT TO app_user
  WITH CHECK (
    workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
    AND ((SELECT app.current_member_role()) IN ('owner', 'admin')
         OR (user_id = app.current_actor_user() AND role = 'owner' AND NOT (SELECT app.workspace_has_members()))));
CREATE POLICY manager_update ON "app"."memberships" FOR UPDATE TO app_user
  USING (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
         AND (SELECT app.current_member_role()) IN ('owner', 'admin'))
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin'));
CREATE POLICY manager_or_self_delete ON "app"."memberships" FOR DELETE TO app_user
  USING (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
         AND ((SELECT app.current_member_role()) IN ('owner', 'admin') OR user_id = app.current_actor_user()));

-- Owner rows: only an owner may grant, change or remove the owner role (an admin manages everyone else), and
-- every change that touches an owner row takes a per-workspace advisory lock until commit, so the deferred
-- last-owner check below sees concurrent demotions (two owners demoting each other at once).
-- SECURITY INVOKER on purpose: `current_user` tells a direct app_user statement apart from the invitation
-- definer function (svc_definer), which never creates owners and validates its own input.
CREATE FUNCTION app.memberships_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_touches_owner boolean;
BEGIN
  v_touches_owner := CASE TG_OP
    WHEN 'INSERT' THEN NEW.role = 'owner'
    WHEN 'DELETE' THEN OLD.role = 'owner'
    ELSE NEW.role IS DISTINCT FROM OLD.role AND 'owner' IN (OLD.role, NEW.role)
  END;
  IF NOT v_touches_owner THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('app.memberships.owner:' || COALESCE(NEW.workspace_id, OLD.workspace_id)::text, 0));
  IF current_user = 'svc_definer' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF app.current_member_role() IS DISTINCT FROM 'owner'
     AND NOT (TG_OP = 'INSERT' AND NOT app.workspace_has_members()) THEN
    RAISE EXCEPTION 'only an owner may grant, change or remove the owner role' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
CREATE TRIGGER memberships_guard BEFORE INSERT OR UPDATE OR DELETE ON "app"."memberships"
  FOR EACH ROW EXECUTE FUNCTION app.memberships_guard();

-- Last-owner protection: checked at commit (DEFERRABLE INITIALLY DEFERRED), so an ownership transfer can promote
-- and demote in one transaction in either order, and a rolled-back statement never trips it. SQLSTATE P5001 is
-- mapped to a typed error by the service layer. A workspace that is itself being purged (P8) has no row left
-- and is not checked.
CREATE FUNCTION app.memberships_keep_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF OLD.role = 'owner'
     AND NOT EXISTS (SELECT 1 FROM app.memberships m WHERE m.workspace_id = OLD.workspace_id AND m.role = 'owner')
     AND EXISTS (SELECT 1 FROM app.workspaces w WHERE w.id = OLD.workspace_id) THEN
    RAISE EXCEPTION 'a workspace must keep at least one owner' USING ERRCODE = 'P5001';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER memberships_keep_owner AFTER UPDATE OF role OR DELETE ON "app"."memberships"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.memberships_keep_owner();

-- ---------------------------------------------------------------- 4. workspaces (FR-WS-02, FR-WS-05 hook)
-- Settings: owners and admins. The deletion request (deleted_at / scheduled_purge_at): owners only, and the
-- dates come from the database clock and the 30-day grace period (SEC-20), never from the caller.
DROP POLICY tenant_update ON "app"."workspaces";
CREATE POLICY manager_update ON "app"."workspaces" FOR UPDATE TO app_user
  USING (id = app.current_workspace() AND status = 'active' AND (SELECT app.current_member_role()) IN ('owner', 'admin'))
  WITH CHECK (id = app.current_workspace() AND status = 'active'
              AND (SELECT app.current_member_role()) IN ('owner', 'admin'));

CREATE FUNCTION app.workspaces_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF current_user = 'svc_definer'
     OR (NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
         AND NEW.scheduled_purge_at IS NOT DISTINCT FROM OLD.scheduled_purge_at) THEN
    RETURN NEW;
  END IF;
  IF app.current_member_role() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'only an owner may request or cancel workspace deletion' USING ERRCODE = '42501';
  END IF;
  IF NEW.deleted_at IS NULL THEN
    NEW.scheduled_purge_at := NULL;
  ELSIF OLD.deleted_at IS NOT NULL THEN
    NEW.deleted_at := OLD.deleted_at;
    NEW.scheduled_purge_at := OLD.scheduled_purge_at;
  ELSE
    NEW.deleted_at := pg_catalog.now();
    NEW.scheduled_purge_at := pg_catalog.now() + interval '30 days';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER workspaces_guard BEFORE UPDATE ON "app"."workspaces"
  FOR EACH ROW EXECUTE FUNCTION app.workspaces_guard();

-- ---------------------------------------------------------------- 5. invitations (FR-AUTH-06)
-- Owners and admins invite and revoke; the inviter is always the acting user. Expiry is bounded.
DROP POLICY tenant_insert ON "app"."invitations";
DROP POLICY tenant_update ON "app"."invitations";
CREATE POLICY manager_insert ON "app"."invitations" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin')
              AND invited_by = app.current_actor_user());
CREATE POLICY manager_update ON "app"."invitations" FOR UPDATE TO app_user
  USING (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
         AND (SELECT app.current_member_role()) IN ('owner', 'admin'))
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin'));

ALTER TABLE "app"."invitations"
  ADD CONSTRAINT "invitations_expiry_bounded" CHECK (expires_at <= created_at + interval '30 days');

-- ---------------------------------------------------------------- 6. SECURITY DEFINER functions
-- Accept an invitation (module 01: accept-once, invalidate token, notify inviter). The invitee is not a member
-- yet, so workspace RLS cannot let them in; this function is the only path. The caller is app_user in an
-- actor-only context (`withActor`); the actor comes from `app.user_id`, never from a parameter. The actor's
-- verified e-mail must equal the invited address. Accept-once: the UPDATE takes the row lock, so a concurrent
-- second acceptance waits, re-checks `accepted_at IS NULL` and finds nothing.
-- Outcomes: accepted | already_member (invitation consumed, role unchanged) | wrong_account | invalid
-- (unknown, expired, revoked, used, or workspace not active: one answer, no oracle).
CREATE FUNCTION app.accept_invitation(p_token_hash text, p_correlation_id text)
RETURNS TABLE (outcome text, workspace_id uuid, workspace_slug text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_actor uuid := app.current_actor_user();
  v_email text;
  v_invitation uuid;
  v_workspace uuid;
  v_role app.member_role;
  v_inviter uuid;
  v_inserted integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'an authenticated actor is required' USING ERRCODE = '42501';
  END IF;
  SELECT u.email INTO v_email FROM identity.users u
   WHERE u.id = v_actor AND u.status = 'active' AND u.email_verified;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the actor is not an active user with a verified e-mail' USING ERRCODE = '42501';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  UPDATE app.invitations i
     SET accepted_at = pg_catalog.now(), accepted_by = v_actor, updated_at = pg_catalog.now()
   WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL
     AND i.expires_at > pg_catalog.now() AND i.email = v_email
     AND EXISTS (SELECT 1 FROM app.workspaces w
                  WHERE w.id = i.workspace_id AND w.status = 'active' AND w.deleted_at IS NULL)
  RETURNING i.id, i.workspace_id, i.role, i.invited_by INTO v_invitation, v_workspace, v_role, v_inviter;

  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM app.invitations i
                WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL
                  AND i.expires_at > pg_catalog.now() AND i.email <> v_email) THEN
      RETURN QUERY SELECT 'wrong_account'::text, NULL::uuid, NULL::text;
    ELSE
      RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text;
    END IF;
    RETURN;
  END IF;

  INSERT INTO app.memberships (workspace_id, user_id, role, created_by)
  VALUES (v_workspace, v_actor, v_role, v_inviter)
  ON CONFLICT (workspace_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  INSERT INTO app.audit_logs (id, workspace_id, actor_type, actor_id, action, target_type, target_id, result,
                              correlation_id, metadata)
  VALUES (app.uuid_generate_v7(), v_workspace, 'user', v_actor, 'workspace.invitation.accepted', 'invitation',
          v_invitation::text, 'success', p_correlation_id,
          pg_catalog.jsonb_build_object('role', v_role, 'already_member', v_inserted = 0));

  -- Notify the inviter in-app; the composite FK requires them to still be a member.
  IF EXISTS (SELECT 1 FROM app.memberships m WHERE m.workspace_id = v_workspace AND m.user_id = v_inviter) THEN
    INSERT INTO app.notifications (workspace_id, user_id, type, payload)
    VALUES (v_workspace, v_inviter, 'workspace.invitation_accepted',
            pg_catalog.jsonb_build_object('invitationId', v_invitation, 'memberUserId', v_actor));
  END IF;

  RETURN QUERY
    SELECT CASE WHEN v_inserted = 1 THEN 'accepted' ELSE 'already_member' END, w.id, w.slug
      FROM app.workspaces w WHERE w.id = v_workspace;
END
$$;

-- What the invitation page shows before acceptance: workspace name, role, a masked address and the expiry, and
-- only for an open invitation in an active workspace. Holding the 256-bit token is the authorization.
CREATE FUNCTION app.invitation_preview(p_token_hash text)
RETURNS TABLE (workspace_name text, role app.member_role, email_hint text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT w.name, i.role,
         pg_catalog.left(i.email, 1) || '***@' || pg_catalog.split_part(i.email, '@', 2),
         i.expires_at
    FROM app.invitations i JOIN app.workspaces w ON w.id = i.workspace_id
   WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND i.token_hash = p_token_hash
     AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > pg_catalog.now()
     AND w.status = 'active' AND w.deleted_at IS NULL
$$;

-- Member directory (FR-WS-02): names and addresses live in `identity`, which app_user cannot read. Returns the
-- members of the current workspace, and only to a member of it (no context or no membership: no rows).
CREATE FUNCTION app.workspace_members()
RETURNS TABLE (membership_id uuid, user_id uuid, role app.member_role, name text, email text, joined_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT m.id, m.user_id, m.role, u.name, u.email, m.created_at
    FROM app.memberships m JOIN identity.users u ON u.id = m.user_id
   WHERE m.workspace_id = app.current_workspace() AND app.current_member_role() IS NOT NULL
   ORDER BY m.created_at, m.id
$$;

-- ---------------------------------------------------------------- 7. privileges and ownership
-- What svc_definer additionally may touch for the functions above, and nothing more.
GRANT SELECT (name, slug) ON "app"."workspaces" TO svc_definer;
GRANT SELECT (email, email_verified, name) ON "identity"."users" TO svc_definer;
GRANT SELECT (id, workspace_id, user_id, role, created_at) ON "app"."memberships" TO svc_definer;
GRANT INSERT (workspace_id, user_id, role, created_by) ON "app"."memberships" TO svc_definer;
GRANT SELECT (id, workspace_id, email, role, token_hash, expires_at, invited_by, accepted_at, revoked_at)
  ON "app"."invitations" TO svc_definer;
GRANT UPDATE (accepted_at, accepted_by, updated_at) ON "app"."invitations" TO svc_definer;
GRANT INSERT (workspace_id, user_id, type, payload) ON "app"."notifications" TO svc_definer;
CREATE POLICY definer_select ON "app"."memberships" FOR SELECT TO svc_definer USING (true);
CREATE POLICY definer_insert ON "app"."memberships" FOR INSERT TO svc_definer WITH CHECK (true);
CREATE POLICY definer_select ON "app"."invitations" FOR SELECT TO svc_definer USING (true);
CREATE POLICY definer_update ON "app"."invitations" FOR UPDATE TO svc_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_insert ON "app"."notifications" FOR INSERT TO svc_definer WITH CHECK (true);

-- EXECUTE before the ownership transfer (S1-2: afterwards migrator is no longer the owner).
REVOKE ALL ON FUNCTION app.reserved_slugs(), app.is_reserved_slug(text), app.current_member_role(),
  app.workspace_has_members(), app.memberships_guard(), app.memberships_keep_owner(), app.workspaces_guard(),
  app.accept_invitation(text, text), app.invitation_preview(text), app.workspace_members() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reserved_slugs(), app.is_reserved_slug(text), app.current_member_role(),
  app.workspace_has_members(), app.accept_invitation(text, text), app.invitation_preview(text),
  app.workspace_members() TO app_user;
-- svc_definer updates workspace rows (suspension), and every UPDATE re-evaluates the slug CHECK.
GRANT EXECUTE ON FUNCTION app.reserved_slugs(), app.is_reserved_slug(text), app.current_actor_user() TO svc_definer;

GRANT CREATE ON SCHEMA "app" TO svc_definer;
ALTER FUNCTION app.current_member_role() OWNER TO svc_definer;
ALTER FUNCTION app.workspace_has_members() OWNER TO svc_definer;
ALTER FUNCTION app.memberships_keep_owner() OWNER TO svc_definer;
ALTER FUNCTION app.accept_invitation(text, text) OWNER TO svc_definer;
ALTER FUNCTION app.invitation_preview(text) OWNER TO svc_definer;
ALTER FUNCTION app.workspace_members() OWNER TO svc_definer;
REVOKE CREATE ON SCHEMA "app" FROM svc_definer;
