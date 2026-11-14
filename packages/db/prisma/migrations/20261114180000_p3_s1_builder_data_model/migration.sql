-- =====================================================================================================
-- P3 S1: the builder data model (SRS §5 data model; FR-BLD-06/07, FR-PUB-01..03 foundations; Implementation
-- Plan Q7, Q15). Runs as `migrator` after 20261114120000_p2_s10_preview_link_sender. Forward-only; rollback is a
-- new migration that drops the five tables, their trigger functions, the helper function and the three types
-- (nothing outside this migration references them).
--
--   site_drafts         the one mutable working config of a project, with a revision counter. Every write moves
--                       the revision by exactly one, so a save that carries a stale revision changes nothing
--                       (optimistic concurrency, FR-BLD-06).
--   change_sets         every change to a draft: who/what proposed it (manual, ai, client), the operations, the
--                       inverse operations once applied (undo = a new ChangeSet that applies them), and its
--                       status. Never deleted: it is the draft's history.
--   site_versions       immutable published snapshots (staging or live). No role can UPDATE, DELETE or TRUNCATE
--                       them: no grant, and triggers that refuse it even for the owner of the table (Q7).
--   site_pointers       per project, which version is the current staging and the current live one. Publishing
--                       and rollback move a pointer; a version never changes.
--   project_edit_locks  one editor per project (FR-BLD-07): an advisory lock with a 2-minute lifetime renewed by
--                       a heartbeat. The database sets the holder and the times, so a client cannot hold a lock
--                       for someone else or for longer.
--
-- Roles (SRS 7, Q15): owners, admins and editors edit drafts, propose and apply changes, and publish to staging;
-- only owners and admins publish to live or move the live pointer. Viewers read. A suspended or deletion-scheduled
-- workspace is read-only (workspace_writable) and an archived or deleted project is read-only (project_editable).
-- =====================================================================================================

CREATE TYPE "app"."change_set_source" AS ENUM ('manual', 'ai', 'client');
CREATE TYPE "app"."change_set_status" AS ENUM ('proposed', 'applied', 'rejected', 'undone');
CREATE TYPE "app"."site_version_kind" AS ENUM ('staging', 'live');

-- A project's builder data can change only while the project is in the caller's workspace, not archived and not
-- deleted. Invoker rights: the projects RLS of the caller applies, so another workspace's project is "not editable".
CREATE FUNCTION app.project_editable(p_project_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.projects p
     WHERE p.id = p_project_id AND p.workspace_id = app.current_workspace()
       AND p.status <> 'archived' AND p.deleted_at IS NULL)
$$;
REVOKE ALL ON FUNCTION app.project_editable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.project_editable(uuid) TO app_user;

-- =============================================================== site_drafts
CREATE TABLE "app"."site_drafts" (
    "id" UUID NOT NULL DEFAULT app.uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "config" JSONB NOT NULL,
    "schema_version" TEXT NOT NULL,
    "based_on_template_version_id" UUID,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_drafts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "site_drafts_workspace_id_id_key" ON "app"."site_drafts"("workspace_id", "id");
CREATE UNIQUE INDEX "site_drafts_workspace_id_project_id_key" ON "app"."site_drafts"("workspace_id", "project_id");

ALTER TABLE "app"."site_drafts"
  ADD CONSTRAINT "site_drafts_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "app"."workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "site_drafts_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id")
    REFERENCES "app"."projects"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- `based_on_template_version_id` is not a foreign key for the same reason as template_preview_links.template_id:
  -- it usually names a platform template version (workspace_id NULL), which a composite tenant FK cannot reach.
  ADD CONSTRAINT "site_drafts_config_object" CHECK (jsonb_typeof(config) = 'object'),
  ADD CONSTRAINT "site_drafts_config_size" CHECK (octet_length(config::text) <= 524288),
  ADD CONSTRAINT "site_drafts_schema_version" CHECK (schema_version ~ '^[0-9]{1,3}\.[0-9]{1,3}$'),
  ADD CONSTRAINT "site_drafts_revision_positive" CHECK (revision >= 1);

-- The database owns the bookkeeping: a draft starts at revision 1, every update moves it by exactly one (the
-- service updates `WHERE revision = <expected>`, so a stale save matches no row), and the authorship columns
-- are set from the transaction's actor.
CREATE FUNCTION app.site_drafts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.revision := 1;
    NEW.created_by := app.current_actor_user();
    NEW.created_at := pg_catalog.now();
    NEW.updated_by := NEW.created_by;
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.workspace_id, NEW.project_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.project_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a draft cannot move to another project' USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'a draft revision moves by exactly one (expected %, got %)', OLD.revision + 1, NEW.revision
      USING ERRCODE = 'P5101';
  END IF;
  NEW.updated_by := app.current_actor_user();
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.site_drafts_guard() FROM PUBLIC;
CREATE TRIGGER site_drafts_guard BEFORE INSERT OR UPDATE ON "app"."site_drafts"
  FOR EACH ROW EXECUTE FUNCTION app.site_drafts_guard();

-- =============================================================== change_sets
CREATE TABLE "app"."change_sets" (
    "id" UUID NOT NULL DEFAULT app.uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "source" "app"."change_set_source" NOT NULL,
    "status" "app"."change_set_status" NOT NULL DEFAULT 'proposed',
    "operations" JSONB NOT NULL,
    "inverse" JSONB,
    "summary" TEXT,
    "base_revision" INTEGER NOT NULL,
    "result_revision" INTEGER,
    "undoes_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "change_sets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "change_sets_workspace_id_id_key" ON "app"."change_sets"("workspace_id", "id");
CREATE INDEX "change_sets_workspace_id_project_id_created_at_idx"
  ON "app"."change_sets"("workspace_id", "project_id", "created_at" DESC);

ALTER TABLE "app"."change_sets"
  ADD CONSTRAINT "change_sets_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "app"."workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "change_sets_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id")
    REFERENCES "app"."projects"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "change_sets_workspace_id_undoes_id_fkey" FOREIGN KEY ("workspace_id", "undoes_id")
    REFERENCES "app"."change_sets"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "change_sets_operations_array" CHECK (jsonb_typeof(operations) = 'array'),
  ADD CONSTRAINT "change_sets_operations_size" CHECK (octet_length(operations::text) <= 262144),
  ADD CONSTRAINT "change_sets_inverse_array" CHECK (inverse IS NULL OR jsonb_typeof(inverse) = 'array'),
  ADD CONSTRAINT "change_sets_inverse_size" CHECK (inverse IS NULL OR octet_length(inverse::text) <= 262144),
  ADD CONSTRAINT "change_sets_summary_length" CHECK (summary IS NULL OR char_length(summary) <= 500),
  ADD CONSTRAINT "change_sets_base_revision_positive" CHECK (base_revision >= 1),
  -- An applied (or later undone) change has its inverse and moved the draft by one revision; a proposed or
  -- rejected one has neither.
  ADD CONSTRAINT "change_sets_applied_shape" CHECK (
    CASE WHEN status IN ('applied', 'undone')
         THEN inverse IS NOT NULL AND result_revision = base_revision + 1
         ELSE inverse IS NULL AND result_revision IS NULL END),
  ADD CONSTRAINT "change_sets_decision_pair" CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  ADD CONSTRAINT "change_sets_not_self_undo" CHECK (undoes_id IS NULL OR undoes_id <> id);

-- Status moves only forward: proposed → applied | rejected, applied → undone. Everything else about a change is
-- fixed once written. The actor columns come from the transaction.
CREATE FUNCTION app.change_sets_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('proposed', 'applied') THEN
      RAISE EXCEPTION 'a change set starts as proposed or applied' USING ERRCODE = 'P5102';
    END IF;
    NEW.created_by := app.current_actor_user();
    NEW.created_at := pg_catalog.now();
    IF NEW.status = 'applied' THEN
      NEW.decided_by := NEW.created_by;
      NEW.decided_at := NEW.created_at;
    ELSE
      NEW.decided_by := NULL;
      NEW.decided_at := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.workspace_id, NEW.project_id, NEW.source, NEW.operations, NEW.summary, NEW.base_revision,
      NEW.undoes_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.workspace_id, OLD.project_id, OLD.source, OLD.operations, OLD.summary, OLD.base_revision,
      OLD.undoes_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'only the status of a change set can change' USING ERRCODE = '42501';
  END IF;
  IF NOT ((OLD.status = 'proposed' AND NEW.status IN ('applied', 'rejected'))
          OR (OLD.status = 'applied' AND NEW.status = 'undone')) THEN
    RAISE EXCEPTION 'a change set cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'P5102';
  END IF;
  IF OLD.status = 'applied' AND (NEW.inverse, NEW.result_revision) IS DISTINCT FROM (OLD.inverse, OLD.result_revision)
  THEN
    RAISE EXCEPTION 'an applied change set keeps its inverse and revision' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'proposed' THEN
    NEW.decided_by := app.current_actor_user();
    NEW.decided_at := pg_catalog.now();
  ELSE
    NEW.decided_by := OLD.decided_by;
    NEW.decided_at := OLD.decided_at;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.change_sets_guard() FROM PUBLIC;
CREATE TRIGGER change_sets_guard BEFORE INSERT OR UPDATE ON "app"."change_sets"
  FOR EACH ROW EXECUTE FUNCTION app.change_sets_guard();

-- =============================================================== site_versions
CREATE TABLE "app"."site_versions" (
    "id" UUID NOT NULL DEFAULT app.uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" "app"."site_version_kind" NOT NULL,
    "config" JSONB NOT NULL,
    "schema_version" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "source_draft_revision" INTEGER NOT NULL,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "site_versions_workspace_id_id_key" ON "app"."site_versions"("workspace_id", "id");
CREATE INDEX "site_versions_workspace_id_project_id_created_at_idx"
  ON "app"."site_versions"("workspace_id", "project_id", "created_at" DESC);

ALTER TABLE "app"."site_versions"
  ADD CONSTRAINT "site_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "app"."workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "site_versions_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id")
    REFERENCES "app"."projects"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "site_versions_config_object" CHECK (jsonb_typeof(config) = 'object'),
  ADD CONSTRAINT "site_versions_config_size" CHECK (octet_length(config::text) <= 524288),
  ADD CONSTRAINT "site_versions_schema_version" CHECK (schema_version ~ '^[0-9]{1,3}\.[0-9]{1,3}$'),
  ADD CONSTRAINT "site_versions_checksum" CHECK (checksum ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "site_versions_source_revision_positive" CHECK (source_draft_revision >= 1),
  ADD CONSTRAINT "site_versions_note_length" CHECK (note IS NULL OR char_length(note) <= 500);

CREATE FUNCTION app.site_versions_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.created_by := app.current_actor_user();
  NEW.created_at := pg_catalog.now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.site_versions_stamp() FROM PUBLIC;
CREATE TRIGGER site_versions_stamp BEFORE INSERT ON "app"."site_versions"
  FOR EACH ROW EXECUTE FUNCTION app.site_versions_stamp();

-- Immutability (Q7): refused for every role, including the table owner, before any privilege question arises.
CREATE FUNCTION app.site_versions_reject_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'a site version is immutable (% rejected)', TG_OP USING ERRCODE = '42501';
END
$$;
REVOKE ALL ON FUNCTION app.site_versions_reject_change() FROM PUBLIC;
CREATE TRIGGER site_versions_immutable BEFORE UPDATE OR DELETE ON "app"."site_versions"
  FOR EACH ROW EXECUTE FUNCTION app.site_versions_reject_change();
CREATE TRIGGER site_versions_no_truncate BEFORE TRUNCATE ON "app"."site_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION app.site_versions_reject_change();

-- =============================================================== site_pointers
CREATE TABLE "app"."site_pointers" (
    "id" UUID NOT NULL DEFAULT app.uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" "app"."site_version_kind" NOT NULL,
    "site_version_id" UUID NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_pointers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "site_pointers_workspace_id_id_key" ON "app"."site_pointers"("workspace_id", "id");
CREATE UNIQUE INDEX "site_pointers_workspace_id_project_id_kind_key"
  ON "app"."site_pointers"("workspace_id", "project_id", "kind");

ALTER TABLE "app"."site_pointers"
  ADD CONSTRAINT "site_pointers_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "app"."workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "site_pointers_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id")
    REFERENCES "app"."projects"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "site_pointers_workspace_id_site_version_id_fkey" FOREIGN KEY ("workspace_id", "site_version_id")
    REFERENCES "app"."site_versions"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A pointer stays on its project and kind, and points only at a version of the same project and kind (a staging
-- snapshot never goes live by pointer: live publishing makes its own live version).
CREATE FUNCTION app.site_pointers_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.workspace_id, NEW.project_id, NEW.kind)
                          IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.project_id, OLD.kind) THEN
    RAISE EXCEPTION 'a pointer cannot move to another project or kind' USING ERRCODE = '42501';
  END IF;
  -- A row for another workspace (or with no tenant context) is left to the RLS WITH CHECK, which refuses it with
  -- 42501 like every other tenant table; looking the version up here would answer differently first.
  IF NEW.workspace_id IS DISTINCT FROM app.current_workspace() THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.site_versions v
                  WHERE v.id = NEW.site_version_id AND v.workspace_id = NEW.workspace_id
                    AND v.project_id = NEW.project_id AND v.kind = NEW.kind) THEN
    RAISE EXCEPTION 'a % pointer must point at a % version of the same project', NEW.kind, NEW.kind
      USING ERRCODE = 'P5103';
  END IF;
  NEW.updated_by := app.current_actor_user();
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.site_pointers_guard() FROM PUBLIC;
CREATE TRIGGER site_pointers_guard BEFORE INSERT OR UPDATE ON "app"."site_pointers"
  FOR EACH ROW EXECUTE FUNCTION app.site_pointers_guard();

-- =============================================================== project_edit_locks
CREATE TABLE "app"."project_edit_locks" (
    "id" UUID NOT NULL DEFAULT app.uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "holder_user_id" UUID NOT NULL,
    "acquired_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeat_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_edit_locks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "project_edit_locks_workspace_id_id_key" ON "app"."project_edit_locks"("workspace_id", "id");
CREATE UNIQUE INDEX "project_edit_locks_workspace_id_project_id_key"
  ON "app"."project_edit_locks"("workspace_id", "project_id");

ALTER TABLE "app"."project_edit_locks"
  ADD CONSTRAINT "project_edit_locks_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "app"."workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_edit_locks_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id")
    REFERENCES "app"."projects"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_edit_locks_lifetime" CHECK (
    expires_at > heartbeat_at AND expires_at <= heartbeat_at + interval '2 minutes');

-- Approved 2026-11-14: a lock lives 2 minutes and is renewed by a heartbeat. The holder is always the actor that
-- writes the row and the database sets every time: a renewal by the holder keeps `acquired_at`; a takeover (after
-- expiry, or by an owner/admin at any time, policy editor_update) starts a new lock.
CREATE FUNCTION app.project_edit_locks_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_actor uuid := app.current_actor_user();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'an edit lock needs a signed-in member' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.workspace_id, NEW.project_id)
                          IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.project_id) THEN
    RAISE EXCEPTION 'an edit lock cannot move to another project' USING ERRCODE = '42501';
  END IF;
  NEW.holder_user_id := v_actor;
  NEW.heartbeat_at := pg_catalog.now();
  NEW.expires_at := NEW.heartbeat_at + interval '2 minutes';
  IF TG_OP = 'INSERT' OR OLD.holder_user_id <> v_actor THEN
    NEW.acquired_at := NEW.heartbeat_at;
  ELSE
    NEW.acquired_at := OLD.acquired_at;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.project_edit_locks_guard() FROM PUBLIC;
CREATE TRIGGER project_edit_locks_guard BEFORE INSERT OR UPDATE ON "app"."project_edit_locks"
  FOR EACH ROW EXECUTE FUNCTION app.project_edit_locks_guard();

-- =============================================================== row-level security
ALTER TABLE "app"."site_drafts" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."change_sets" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."site_versions" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."site_pointers" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."project_edit_locks" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

-- Every member of the workspace reads its builder data (viewers see drafts, history and who is editing).
CREATE POLICY tenant_select ON "app"."site_drafts" FOR SELECT TO app_user
  USING (workspace_id = app.current_workspace());
CREATE POLICY tenant_select ON "app"."change_sets" FOR SELECT TO app_user
  USING (workspace_id = app.current_workspace());
CREATE POLICY tenant_select ON "app"."site_versions" FOR SELECT TO app_user
  USING (workspace_id = app.current_workspace());
CREATE POLICY tenant_select ON "app"."site_pointers" FOR SELECT TO app_user
  USING (workspace_id = app.current_workspace());
CREATE POLICY tenant_select ON "app"."project_edit_locks" FOR SELECT TO app_user
  USING (workspace_id = app.current_workspace());

-- Drafts and change sets: owners, admins and editors, writable workspace, editable project.
CREATE POLICY editor_insert ON "app"."site_drafts" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor')
              AND app.project_editable(project_id));
CREATE POLICY editor_update ON "app"."site_drafts" FOR UPDATE TO app_user
  USING (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
         AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor')
         AND app.project_editable(project_id))
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor')
              AND app.project_editable(project_id));
CREATE POLICY editor_insert ON "app"."change_sets" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor')
              AND app.project_editable(project_id));
CREATE POLICY editor_update ON "app"."change_sets" FOR UPDATE TO app_user
  USING (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
         AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor')
         AND app.project_editable(project_id))
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor')
              AND app.project_editable(project_id));

-- Publishing (Q15, default policy): editors may publish to staging only; live is for owners and admins.
CREATE POLICY publisher_insert ON "app"."site_versions" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND app.project_editable(project_id)
              AND ((SELECT app.current_member_role()) IN ('owner', 'admin')
                   OR (kind = 'staging' AND (SELECT app.current_member_role()) = 'editor')));
CREATE POLICY publisher_insert ON "app"."site_pointers" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND app.project_editable(project_id)
              AND ((SELECT app.current_member_role()) IN ('owner', 'admin')
                   OR (kind = 'staging' AND (SELECT app.current_member_role()) = 'editor')));
CREATE POLICY publisher_update ON "app"."site_pointers" FOR UPDATE TO app_user
  USING (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
         AND app.project_editable(project_id)
         AND ((SELECT app.current_member_role()) IN ('owner', 'admin')
              OR (kind = 'staging' AND (SELECT app.current_member_role()) = 'editor')))
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND app.project_editable(project_id)
              AND ((SELECT app.current_member_role()) IN ('owner', 'admin')
                   OR (kind = 'staging' AND (SELECT app.current_member_role()) = 'editor')));

-- Edit locks: any member who may edit takes a free or expired lock and renews their own; an owner or admin may
-- take it over at any time (approved 2026-11-14; the service audits a forced takeover). Releasing is deleting:
-- the holder, or an owner/admin.
CREATE POLICY editor_insert ON "app"."project_edit_locks" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor')
              AND app.project_editable(project_id));
CREATE POLICY editor_update ON "app"."project_edit_locks" FOR UPDATE TO app_user
  USING (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
         AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor')
         AND app.project_editable(project_id)
         AND (holder_user_id = app.current_actor_user() OR expires_at < pg_catalog.now()
              OR (SELECT app.current_member_role()) IN ('owner', 'admin')))
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor')
              AND app.project_editable(project_id));
CREATE POLICY holder_delete ON "app"."project_edit_locks" FOR DELETE TO app_user
  USING (workspace_id = app.current_workspace()
         AND (holder_user_id = app.current_actor_user()
              OR (SELECT app.current_member_role()) IN ('owner', 'admin')));

-- =============================================================== privileges (least privilege)
GRANT SELECT ON "app"."site_drafts", "app"."change_sets", "app"."site_versions", "app"."site_pointers",
  "app"."project_edit_locks" TO app_user;

-- Prisma sends its own values for defaulted columns; the guards overwrite the revision, actors and times.
GRANT INSERT (id, workspace_id, project_id, config, schema_version, based_on_template_version_id, revision,
              created_at, updated_at)
  ON "app"."site_drafts" TO app_user;
GRANT UPDATE (config, schema_version, based_on_template_version_id, revision) ON "app"."site_drafts" TO app_user;

GRANT INSERT (id, workspace_id, project_id, source, status, operations, inverse, summary, base_revision,
              result_revision, undoes_id, created_at)
  ON "app"."change_sets" TO app_user;
GRANT UPDATE (status, inverse, result_revision) ON "app"."change_sets" TO app_user;

GRANT INSERT (id, workspace_id, project_id, kind, config, schema_version, checksum, source_draft_revision, note,
              created_at)
  ON "app"."site_versions" TO app_user;

GRANT INSERT (id, workspace_id, project_id, kind, site_version_id, updated_at) ON "app"."site_pointers" TO app_user;
GRANT UPDATE (site_version_id) ON "app"."site_pointers" TO app_user;

-- The holder and the times are overwritten by project_edit_locks_guard; the grants only let a client name them.
GRANT INSERT (id, workspace_id, project_id, holder_user_id, acquired_at, heartbeat_at, expires_at) ON "app"."project_edit_locks" TO app_user;
GRANT UPDATE (holder_user_id, heartbeat_at, expires_at) ON "app"."project_edit_locks" TO app_user;
GRANT DELETE ON "app"."project_edit_locks" TO app_user;
