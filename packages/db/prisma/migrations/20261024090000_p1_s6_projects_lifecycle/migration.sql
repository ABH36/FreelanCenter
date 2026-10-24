-- =====================================================================================================
-- P1 S6: projects, lifecycle, platform subdomains, audit viewer support, in-app notifications with preferences,
-- transactional outbox and job dead letters (SRS 5.1, 5.3, 6.3, 6.12, 6.16; FR-PRJ-01 P1 part, FR-PRJ-02..05,
-- FR-DOM-01, FR-AUD-01 viewer, FR-NOT-01; Q9; S5 decisions D4/D5). Runs as `migrator` after
-- 20261023120000_p1_s5_workspaces_rbac.
--
-- Section map: 1 tables (Prisma-generated DDL) - 2 constraints - 3 platform settings - 4 project lifecycle
-- (transition table, guard trigger, role-gated policies) - 5 client contacts - 6 platform subdomains (definer
-- allocator, app_user INSERT revoked) - 7 notifications and preferences - 8 outbox - 9 dead letters
-- 10 privileges and ownership.
--
-- The service layer (`@platform/workspaces`, projects.ts) authorizes every command with `authorize()` first; the
-- transition table, the role checks and the subdomain rules below repeat that in the database (SEC-10), so a bug
-- in a service cannot let a viewer edit a project, an editor publish, or any member claim an arbitrary host name.
-- Every RLS change has a matching test (SRS 11.2).
-- =====================================================================================================

-- ---------------------------------------------------------------- 1. tables (Prisma-generated DDL)
ALTER TABLE "app"."projects" ADD COLUMN "creation_key" UUID,
ADD COLUMN "duplicated_from_id" UUID;

CREATE TABLE "app"."notification_preferences" (
    "id" UUID NOT NULL DEFAULT app.uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app"."outbox_events" (
    "id" UUID NOT NULL DEFAULT app.uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app"."job_dead_letters" (
    "id" UUID NOT NULL DEFAULT app.uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "function_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "event" TEXT,
    "target_type" TEXT,
    "target_id" TEXT,
    "error" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_dead_letters_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app"."platform_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "notification_preferences_workspace_id_user_id_category_key" ON "app"."notification_preferences"("workspace_id", "user_id", "category");
CREATE INDEX "outbox_events_workspace_id_created_at_idx" ON "app"."outbox_events"("workspace_id", "created_at");
CREATE INDEX "job_dead_letters_workspace_id_created_at_idx" ON "app"."job_dead_letters"("workspace_id", "created_at" DESC);
CREATE UNIQUE INDEX "projects_workspace_id_creation_key_key" ON "app"."projects"("workspace_id", "creation_key");

ALTER TABLE "app"."projects" ADD CONSTRAINT "projects_workspace_id_duplicated_from_id_fkey" FOREIGN KEY ("workspace_id", "duplicated_from_id") REFERENCES "app"."projects"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "app"."notification_preferences" ADD CONSTRAINT "notification_preferences_workspace_id_user_id_fkey" FOREIGN KEY ("workspace_id", "user_id") REFERENCES "app"."memberships"("workspace_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app"."outbox_events" ADD CONSTRAINT "outbox_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "app"."job_dead_letters" ADD CONSTRAINT "job_dead_letters_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- 2. constraints
ALTER TABLE "app"."notification_preferences"
  ADD CONSTRAINT "notification_preferences_category_format"
    CHECK (char_length(category) <= 64 AND category ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');

-- Ids only, small: an outbox payload is copied to Inngest, which stores it outside India (privacy inventory).
ALTER TABLE "app"."outbox_events"
  ADD CONSTRAINT "outbox_events_event_format"
    CHECK (char_length(event) <= 100 AND event ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$'),
  ADD CONSTRAINT "outbox_events_payload_bounded"
    CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 1024),
  ADD CONSTRAINT "outbox_events_attempts_bounded" CHECK (attempts BETWEEN 0 AND 1000),
  ADD CONSTRAINT "outbox_events_last_error_length" CHECK (char_length(last_error) <= 500);
-- What the sweep scans: undispatched events, oldest first.
CREATE INDEX "outbox_events_pending" ON "app"."outbox_events" (created_at) WHERE dispatched_at IS NULL;

ALTER TABLE "app"."job_dead_letters"
  ADD CONSTRAINT "job_dead_letters_field_lengths" CHECK (
    char_length(function_id) <= 100 AND char_length(run_id) <= 64 AND char_length(event) <= 100
    AND char_length(target_type) <= 64 AND char_length(target_id) <= 128 AND char_length(error) <= 500);

ALTER TABLE "app"."platform_settings"
  ADD CONSTRAINT "platform_settings_known_key" CHECK (key IN ('sites_domain')),
  ADD CONSTRAINT "platform_settings_value_length" CHECK (char_length(value) BETWEEN 1 AND 253);

-- Q9: a platform subdomain's label (the part before the sites domain) is never a reserved word; the same list as
-- workspace slugs (S5). The allocator below also guarantees the label is followed by the configured sites domain.
ALTER TABLE "app"."domains"
  ADD CONSTRAINT "domains_subdomain_label_not_reserved"
    CHECK (type <> 'subdomain' OR NOT app.is_reserved_slug(split_part(hostname, '.', 1)));

ALTER TABLE "app"."platform_settings"        ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."notification_preferences" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."outbox_events"            ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."job_dead_letters"         ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- 3. platform settings
-- Operator runbook only (connect as migrator through DIRECT_URL), like the platform-admin grants: sets one
-- environment's value, e.g. `SELECT app.operator_set_platform_setting('sites_domain', 'example-sites.com')`.
-- Changing the sites domain later does not move existing host names (P7A runbook). Audited as a platform event.
-- Returns false when the value was already set (idempotent: no change, no audit row).
CREATE FUNCTION app.operator_set_platform_setting(p_key text, p_value text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_previous text;
BEGIN
  IF p_key = 'sites_domain' AND (
       p_value IS NULL OR char_length(p_value) > 190
       OR p_value !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z]([a-z0-9-]{0,61}[a-z0-9])?$') THEN
    RAISE EXCEPTION 'sites_domain must be a lower-case host name of at most 190 characters' USING ERRCODE = '22023';
  END IF;
  SELECT s.value INTO v_previous FROM app.platform_settings s WHERE s.key = p_key;
  IF v_previous = p_value THEN
    RETURN false;
  END IF;
  IF v_previous IS NULL THEN
    INSERT INTO app.platform_settings (key, value, updated_at) VALUES (p_key, p_value, pg_catalog.now());
  ELSE
    UPDATE app.platform_settings SET value = p_value, updated_at = pg_catalog.now() WHERE key = p_key;
  END IF;
  INSERT INTO app.audit_logs (id, workspace_id, actor_type, action, target_type, target_id, result, metadata)
  VALUES (app.uuid_generate_v7(), NULL, 'system', 'admin.platform_setting.changed', 'platform_setting', p_key,
          'success', pg_catalog.jsonb_build_object('value', p_value, 'previous', v_previous));
  RETURN true;
END
$$;

-- ---------------------------------------------------------------- 4. project lifecycle (FR-PRJ-02)
-- The transition table: the roles that may move a project from one status to another, or NULL when the move is
-- not allowed at all. It must equal PROJECT_TRANSITIONS in packages/workspaces/src/lifecycle.ts (asserted by the
-- integration suite for all 36 pairs). Draft -> InReview -> Approved -> Live <-> Paused is the main path; review
-- can send a project back to Draft; any status except Archived can be archived; restoring goes back to Draft.
CREATE FUNCTION app.project_transition_roles(p_from app.project_status, p_to app.project_status)
RETURNS app.member_role[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_from = 'draft'     AND p_to = 'in_review' THEN ARRAY['owner', 'admin', 'editor']::app.member_role[]
    WHEN p_from = 'in_review' AND p_to = 'draft'     THEN ARRAY['owner', 'admin', 'editor']::app.member_role[]
    WHEN p_from = 'in_review' AND p_to = 'approved'  THEN ARRAY['owner', 'admin']::app.member_role[]
    WHEN p_from = 'approved'  AND p_to = 'draft'     THEN ARRAY['owner', 'admin', 'editor']::app.member_role[]
    WHEN p_from = 'approved'  AND p_to = 'live'      THEN ARRAY['owner', 'admin']::app.member_role[]
    WHEN p_from = 'live'      AND p_to = 'paused'    THEN ARRAY['owner', 'admin']::app.member_role[]
    WHEN p_from = 'paused'    AND p_to = 'live'      THEN ARRAY['owner', 'admin']::app.member_role[]
    WHEN p_from <> 'archived' AND p_to = 'archived'  THEN ARRAY['owner', 'admin']::app.member_role[]
    WHEN p_from = 'archived'  AND p_to = 'draft'     THEN ARRAY['owner', 'admin']::app.member_role[]
  END
$$;

-- Every INSERT and UPDATE of a project as an application role. SECURITY INVOKER: the checks run with the caller's
-- own role and RLS. On INSERT the creator and the status timestamp come from the database. On UPDATE a status
-- change must be in the transition table for the actor's role (SQLSTATE P5002 = not a valid transition, 42501 =
-- not for this role); Live additionally needs an active platform subdomain (P5006; P3 adds a published
-- SiteVersion). An archived project is read-only until restored (P5003). A job scope has no actor and therefore
-- no role, so it cannot change a status.
CREATE FUNCTION app.projects_guard() RETURNS trigger
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
CREATE TRIGGER projects_guard BEFORE INSERT OR UPDATE ON "app"."projects"
  FOR EACH ROW EXECUTE FUNCTION app.projects_guard();

-- SRS 7 "Create/archive projects", "Edit draft": owners, admins and editors create and edit; viewers only read.
-- The finer per-transition roles are the trigger's job.
DROP POLICY tenant_insert ON "app"."projects";
DROP POLICY tenant_update ON "app"."projects";
CREATE POLICY editor_insert ON "app"."projects" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace() AND status = 'draft' AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'));
CREATE POLICY editor_update ON "app"."projects" FOR UPDATE TO app_user
  USING (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
         AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'))
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'));

-- ---------------------------------------------------------------- 5. client contacts (FR-PRJ-03)
DROP POLICY tenant_insert ON "app"."client_contacts";
DROP POLICY tenant_update ON "app"."client_contacts";
CREATE POLICY editor_insert ON "app"."client_contacts" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'));
CREATE POLICY editor_update ON "app"."client_contacts" FOR UPDATE TO app_user
  USING (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
         AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'))
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor'));

-- ---------------------------------------------------------------- 6. platform subdomains (FR-DOM-01, Q9)
-- app_user can no longer insert domains at all: with a plain INSERT grant a member could claim any host name
-- (`www.some-bank.com` typed as a "subdomain") and take it over (SEC-12). The only path is this allocator, which
-- builds `<label>.<sites_domain>` itself. Q9: the label if free, else `<label>-<4 random [a-z0-9]>`; a reserved
-- label always gets the suffix. Hostnames are globally unique (another tenant's name is skipped by ON CONFLICT
-- without revealing anything a DNS lookup would not). Idempotent: a project that already has a live platform
-- subdomain gets it back. A per-project advisory lock serializes concurrent calls for the same project.
-- Unknown project, foreign project, viewer, no actor or read-only workspace: one answer, 42501.
CREATE FUNCTION app.allocate_platform_subdomain(p_project_id uuid, p_label text)
RETURNS TABLE (domain_id uuid, hostname text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_workspace uuid := app.current_workspace();
  v_role app.member_role := app.current_member_role();
  v_sites_domain text;
  v_label text;
  v_hostname text;
  v_id uuid;
  v_attempt integer := 0;
BEGIN
  IF v_workspace IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'editor')
     OR NOT app.workspace_writable() OR p_project_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM app.projects p
                     WHERE p.id = p_project_id AND p.workspace_id = v_workspace AND p.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'cannot allocate a subdomain for this project' USING ERRCODE = '42501';
  END IF;
  IF p_label IS NULL OR p_label !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' OR position('--' IN p_label) > 0 THEN
    RAISE EXCEPTION 'a subdomain label has 3-40 lower-case letters, digits and single hyphens' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app.domains.subdomain:' || p_project_id::text, 0));

  RETURN QUERY
    SELECT d.id, d.hostname FROM app.domains d
     WHERE d.workspace_id = v_workspace AND d.project_id = p_project_id AND d.type = 'subdomain'
       AND d.deleted_at IS NULL;
  IF FOUND THEN
    RETURN;
  END IF;

  SELECT s.value INTO v_sites_domain FROM app.platform_settings s WHERE s.key = 'sites_domain';
  IF v_sites_domain IS NULL THEN
    RAISE EXCEPTION 'platform subdomains are not configured (sites_domain)' USING ERRCODE = 'P5004';
  END IF;

  LOOP
    IF v_attempt = 0 AND NOT app.is_reserved_slug(p_label) THEN
      v_label := p_label;
    ELSE
      v_label := p_label || '-' || (
        SELECT pg_catalog.string_agg(
                 pg_catalog.substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + pg_catalog.floor(pg_catalog.random() * 36)::integer, 1), '')
          FROM pg_catalog.generate_series(1, 4));
    END IF;
    v_hostname := v_label || '.' || v_sites_domain;
    INSERT INTO app.domains (workspace_id, project_id, hostname, type, status, activated_at)
    VALUES (v_workspace, p_project_id, v_hostname, 'subdomain', 'active', pg_catalog.now())
    ON CONFLICT (hostname) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      RETURN QUERY SELECT v_id, v_hostname;
      RETURN;
    END IF;
    v_attempt := v_attempt + 1;
    IF v_attempt > 8 THEN
      RAISE EXCEPTION 'no free platform subdomain for this label' USING ERRCODE = 'P5005';
    END IF;
  END LOOP;
END
$$;

DROP POLICY tenant_insert ON "app"."domains";
REVOKE INSERT ON "app"."domains" FROM app_user;
-- Soft-deleting a domain (FR-DOM-08 cleanup lands in P7A) is "Manage domains": owners and admins.
DROP POLICY tenant_update ON "app"."domains";
CREATE POLICY manager_update ON "app"."domains" FOR UPDATE TO app_user
  USING (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
         AND (SELECT app.current_member_role()) IN ('owner', 'admin'))
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin'));

-- ---------------------------------------------------------------- 7. notifications and preferences (FR-NOT-01)
-- Preferences: readable inside the workspace (the service reads recipients' choices when it notifies them; no
-- personal data), written only by the member themself while the workspace is writable.
CREATE POLICY tenant_select ON "app"."notification_preferences" FOR SELECT TO app_user
  USING (workspace_id = app.current_workspace());
CREATE POLICY self_insert ON "app"."notification_preferences" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace() AND user_id = app.current_actor_user()
              AND (SELECT app.workspace_writable()));
CREATE POLICY self_update ON "app"."notification_preferences" FOR UPDATE TO app_user
  USING (workspace_id = app.current_workspace() AND user_id = app.current_actor_user()
         AND (SELECT app.workspace_writable()))
  WITH CHECK (workspace_id = app.current_workspace() AND user_id = app.current_actor_user()
              AND (SELECT app.workspace_writable()));
CREATE POLICY self_delete ON "app"."notification_preferences" FOR DELETE TO app_user
  USING (workspace_id = app.current_workspace() AND user_id = app.current_actor_user()
         AND (SELECT app.workspace_writable()));

-- What the e-mail job needs to deliver one notification: the recipient's address (in `identity`, which app_user
-- cannot read), the notification, the workspace name and the recipient's explicit e-mail choices per category
-- (the job applies the category defaults). Only in a job scope (workspace context, no actor), only for the
-- current workspace, only for an active, verified recipient, who is still a member (composite FK).
CREATE FUNCTION app.notification_delivery(p_notification_id uuid)
RETURNS TABLE (recipient_email text, type text, payload jsonb, email_choices jsonb, workspace_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT u.email, n.type, n.payload,
         COALESCE((SELECT pg_catalog.jsonb_object_agg(p.category, p.email) FROM app.notification_preferences p
                    WHERE p.workspace_id = n.workspace_id AND p.user_id = n.user_id), '{}'::jsonb),
         w.name
    FROM app.notifications n
    JOIN identity.users u ON u.id = n.user_id
    JOIN app.workspaces w ON w.id = n.workspace_id
   WHERE app.current_actor_user() IS NULL AND n.workspace_id = app.current_workspace()
     AND n.id = p_notification_id AND u.status = 'active' AND u.email_verified
$$;

-- ---------------------------------------------------------------- 8. outbox (cross-module contracts; S5 D4)
-- Written in the transaction of the state change by any member context; read and marked dispatched inside the
-- workspace (request after commit, or the sweep job). Ids only. No DELETE: purged by `retention.sweep` (P8).
CREATE POLICY tenant_select ON "app"."outbox_events" FOR SELECT TO app_user
  USING (workspace_id = app.current_workspace());
-- Prisma sends the attempts default explicitly (like enum defaults, S1), so attempts is in the INSERT list; the
-- policy pins a fresh row, so nobody can write an event the sweep would skip.
CREATE POLICY tenant_insert ON "app"."outbox_events" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace() AND attempts = 0 AND dispatched_at IS NULL);
CREATE POLICY tenant_update ON "app"."outbox_events" FOR UPDATE TO app_user
  USING (workspace_id = app.current_workspace())
  WITH CHECK (workspace_id = app.current_workspace());

-- The sweep's only cross-workspace read: ids of events that are still undispatched p_min_age_seconds after they
-- were written (a lost emit; the job passes 60). Only with no context at all (`withSystem`, ESLint-confined to the sweep): a request or
-- job transaction, which always carries an actor or a workspace, gets nothing.
CREATE FUNCTION app.outbox_pending(p_limit integer, p_min_age_seconds integer)
RETURNS TABLE (id uuid, workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id, o.workspace_id FROM app.outbox_events o
   WHERE app.current_workspace() IS NULL AND app.current_actor_user() IS NULL
     AND o.dispatched_at IS NULL AND o.attempts < 20
     AND o.created_at <= pg_catalog.now() - pg_catalog.make_interval(secs => GREATEST(COALESCE(p_min_age_seconds, 60), 0))
   ORDER BY o.created_at
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 0), 0), 500)
$$;

-- ---------------------------------------------------------------- 9. job dead letters (ADR-007 rule 4; S5 D5)
-- Appended by job handlers (workspace context); read by owners and admins; never changed by app_user.
CREATE POLICY tenant_insert ON "app"."job_dead_letters" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace());
CREATE POLICY manager_select ON "app"."job_dead_letters" FOR SELECT TO app_user
  USING (workspace_id = app.current_workspace() AND (SELECT app.current_member_role()) IN ('owner', 'admin'));

-- ---------------------------------------------------------------- 10. privileges and ownership
GRANT INSERT (creation_key, duplicated_from_id) ON "app"."projects" TO app_user;
GRANT SELECT ON "app"."notification_preferences", "app"."outbox_events", "app"."job_dead_letters" TO app_user;
GRANT INSERT (id, workspace_id, user_id, category, in_app, email, created_at, updated_at)
  ON "app"."notification_preferences" TO app_user;
GRANT UPDATE (in_app, email, updated_at) ON "app"."notification_preferences" TO app_user;
GRANT DELETE ON "app"."notification_preferences" TO app_user;
GRANT INSERT (id, workspace_id, event, payload, attempts, created_at) ON "app"."outbox_events" TO app_user;
GRANT UPDATE (attempts, last_error, dispatched_at) ON "app"."outbox_events" TO app_user;
GRANT INSERT (id, workspace_id, function_id, run_id, event, target_type, target_id, error, created_at)
  ON "app"."job_dead_letters" TO app_user;

-- What svc_definer additionally may touch for the functions above, and nothing more.
GRANT SELECT (key, value) ON "app"."platform_settings" TO svc_definer;
GRANT INSERT (key, value, updated_at), UPDATE (value, updated_at) ON "app"."platform_settings" TO svc_definer;
GRANT SELECT (id, workspace_id, deleted_at) ON "app"."projects" TO svc_definer;
GRANT SELECT (id, workspace_id, project_id, hostname, type, deleted_at) ON "app"."domains" TO svc_definer;
GRANT INSERT (workspace_id, project_id, hostname, type, status, activated_at) ON "app"."domains" TO svc_definer;
GRANT SELECT (id, workspace_id, user_id, type, payload) ON "app"."notifications" TO svc_definer;
GRANT SELECT (workspace_id, user_id, category, email) ON "app"."notification_preferences" TO svc_definer;
GRANT SELECT (id, workspace_id, created_at, dispatched_at, attempts) ON "app"."outbox_events" TO svc_definer;
GRANT SELECT (id, status, email_verified) ON "identity"."users" TO svc_definer;
CREATE POLICY definer_select ON "app"."platform_settings" FOR SELECT TO svc_definer USING (true);
CREATE POLICY definer_insert ON "app"."platform_settings" FOR INSERT TO svc_definer WITH CHECK (true);
CREATE POLICY definer_update ON "app"."platform_settings" FOR UPDATE TO svc_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_select ON "app"."projects" FOR SELECT TO svc_definer USING (true);
CREATE POLICY definer_select ON "app"."domains" FOR SELECT TO svc_definer USING (true);
CREATE POLICY definer_insert ON "app"."domains" FOR INSERT TO svc_definer WITH CHECK (type = 'subdomain');
CREATE POLICY definer_select ON "app"."notifications" FOR SELECT TO svc_definer USING (true);
CREATE POLICY definer_select ON "app"."notification_preferences" FOR SELECT TO svc_definer USING (true);
CREATE POLICY definer_select ON "app"."outbox_events" FOR SELECT TO svc_definer USING (true);

-- EXECUTE before the ownership transfer (S1-2).
REVOKE ALL ON FUNCTION app.operator_set_platform_setting(text, text),
  app.project_transition_roles(app.project_status, app.project_status), app.projects_guard(),
  app.allocate_platform_subdomain(uuid, text), app.notification_delivery(uuid),
  app.outbox_pending(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.project_transition_roles(app.project_status, app.project_status),
  app.allocate_platform_subdomain(uuid, text), app.notification_delivery(uuid),
  app.outbox_pending(integer, integer) TO app_user;
-- svc_definer already holds what the functions call: is_reserved_slug for the label CHECK (S5-1),
-- current_workspace/current_actor_user, and current_member_role/workspace_writable as their owner.

GRANT CREATE ON SCHEMA "app" TO svc_definer;
ALTER FUNCTION app.operator_set_platform_setting(text, text) OWNER TO svc_definer;
ALTER FUNCTION app.allocate_platform_subdomain(uuid, text) OWNER TO svc_definer;
ALTER FUNCTION app.notification_delivery(uuid) OWNER TO svc_definer;
ALTER FUNCTION app.outbox_pending(integer, integer) OWNER TO svc_definer;
REVOKE CREATE ON SCHEMA "app" FROM svc_definer;
SET ROLE svc_definer;
GRANT EXECUTE ON FUNCTION app.operator_set_platform_setting(text, text) TO migrator;
RESET ROLE;
