-- =====================================================================================================
-- P3 S6: the project asset library (FR-BLD-05, SEC-08, ADR-009; design approved by the Owner 2026-11-15). Runs as
-- `migrator` after 20261115090000_p3_s2_catalog_template_for_draft. Forward-only; rollback is a new migration that
-- drops the table, its trigger function and the type (nothing outside this migration references them; site configs
-- name assets by id inside JSON only).
--
--   assets   one uploaded image of a project. The browser uploads the original straight to a private bucket with a
--            short-lived signed URL; the server then checks it (magic bytes, size, pixel count), re-encodes it into
--            fixed WebP widths without metadata, stores those in the public asset bucket and deletes the original.
--            The row records the outcome: pending -> ready | rejected.
--
-- Object keys come from `storage_token`, a random 128-bit value made by the server, never from the file name:
--   upload   uploads/ws/<workspace_id>/<asset_id>/<storage_token>       (private bucket, deleted after processing)
--   variant  ws/<workspace_id>/<asset_id>/<storage_token>/<width>.webp  (public bucket, immutable)
--
-- Deleting is hiding (approved decision): `deleted_at` takes the image out of the library, but its variants stay,
-- so drafts and published versions that use it keep working. Removing unused files is retention work (P8).
-- Approved cap: 200 images per project (ready ones, plus uploads started in the last hour).
-- =====================================================================================================

CREATE TYPE "app"."asset_status" AS ENUM ('pending', 'ready', 'rejected');

CREATE TABLE "app"."assets" (
    "id" UUID NOT NULL DEFAULT app.uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" "app"."asset_status" NOT NULL DEFAULT 'pending',
    "file_name" TEXT NOT NULL,
    "declared_type" TEXT NOT NULL,
    "declared_bytes" INTEGER NOT NULL,
    "storage_token" TEXT NOT NULL,
    "alt" TEXT NOT NULL DEFAULT '',
    "width" INTEGER,
    "height" INTEGER,
    "variant_widths" INTEGER[],
    "variant_bytes" INTEGER,
    "reject_reason" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "assets_workspace_id_id_key" ON "app"."assets"("workspace_id", "id");
CREATE INDEX "assets_workspace_id_project_id_created_at_idx"
  ON "app"."assets"("workspace_id", "project_id", "created_at" DESC);

ALTER TABLE "app"."assets"
  ADD CONSTRAINT "assets_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "app"."workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "assets_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id")
    REFERENCES "app"."projects"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Approved 2026-11-15: JPEG, PNG and WebP only (HEIC and SVG are refused), at most 10 MB.
  ADD CONSTRAINT "assets_declared_type" CHECK (declared_type IN ('image/jpeg', 'image/png', 'image/webp')),
  ADD CONSTRAINT "assets_declared_bytes" CHECK (declared_bytes BETWEEN 1 AND 10485760),
  ADD CONSTRAINT "assets_storage_token" CHECK (storage_token ~ '^[A-Za-z0-9_-]{22}$'),
  ADD CONSTRAINT "assets_file_name" CHECK (char_length(file_name) BETWEEN 1 AND 200),
  ADD CONSTRAINT "assets_alt_length" CHECK (char_length(alt) <= 250),
  -- A ready image has its size and at least one of the fixed widths (ADR-009); a rejected one says why.
  -- (coalesce: a CHECK passes on NULL, so a missing column must count as false.)
  ADD CONSTRAINT "assets_ready_shape" CHECK (
    CASE WHEN status = 'ready'
         THEN coalesce(width BETWEEN 1 AND 20000 AND height BETWEEN 1 AND 20000 AND variant_bytes >= 1
              AND cardinality(variant_widths) BETWEEN 1 AND 4
              AND variant_widths <@ ARRAY[400, 800, 1200, 1600] AND finalized_at IS NOT NULL, false)
         ELSE width IS NULL AND height IS NULL AND variant_widths IS NULL AND variant_bytes IS NULL END),
  ADD CONSTRAINT "assets_reject_reason" CHECK (
    CASE WHEN status = 'rejected'
         THEN coalesce(reject_reason ~ '^[a-z_]{1,40}$' AND finalized_at IS NOT NULL, false)
         ELSE reject_reason IS NULL END),
  ADD CONSTRAINT "assets_pending_open" CHECK (status <> 'pending' OR finalized_at IS NULL),
  ADD CONSTRAINT "assets_deletion_pair" CHECK ((deleted_by IS NULL) = (deleted_at IS NULL));

-- The database owns the bookkeeping: an asset starts pending and leaves that state once; what was uploaded (name,
-- type, size, storage token) never changes; the actor and time columns come from the transaction. Hiding is
-- one-way. The image count per project is checked here, under a per-project advisory lock, so two uploads started
-- at the same moment cannot both pass a full library.
CREATE FUNCTION app.assets_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_count integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'an asset starts as pending' USING ERRCODE = 'P5102';
    END IF;
    NEW.created_by := app.current_actor_user();
    NEW.created_at := pg_catalog.now();
    NEW.updated_by := NEW.created_by;
    NEW.updated_at := NEW.created_at;
    NEW.finalized_at := NULL;
    NEW.deleted_by := NULL;
    NEW.deleted_at := NULL;
    -- Another workspace's row (or no tenant context) is left to the RLS WITH CHECK, which answers 42501.
    IF NEW.workspace_id IS DISTINCT FROM app.current_workspace() THEN
      RETURN NEW;
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app.assets:' || NEW.project_id::text, 0));
    SELECT count(*) INTO v_count FROM app.assets a
     WHERE a.workspace_id = NEW.workspace_id AND a.project_id = NEW.project_id AND a.deleted_at IS NULL
       AND (a.status = 'ready'
            OR (a.status = 'pending' AND a.created_at > pg_catalog.now() - interval '1 hour'));
    IF v_count >= 200 THEN
      RAISE EXCEPTION 'a project holds at most 200 images' USING ERRCODE = 'P5104';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.workspace_id, NEW.project_id, NEW.file_name, NEW.declared_type, NEW.declared_bytes,
      NEW.storage_token, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.workspace_id, OLD.project_id, OLD.file_name, OLD.declared_type, OLD.declared_bytes,
      OLD.storage_token, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'an uploaded asset keeps its project, name, type, size and storage key' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('ready', 'rejected')) THEN
    RAISE EXCEPTION 'an asset cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'P5102';
  END IF;
  IF OLD.status <> 'pending'
     AND (NEW.width, NEW.height, NEW.variant_widths, NEW.variant_bytes, NEW.reject_reason)
         IS DISTINCT FROM (OLD.width, OLD.height, OLD.variant_widths, OLD.variant_bytes, OLD.reject_reason) THEN
    RAISE EXCEPTION 'a processed asset keeps its variants' USING ERRCODE = '42501';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'a deleted asset stays deleted' USING ERRCODE = 'P5102';
  END IF;
  IF OLD.status = 'pending' AND NEW.status <> 'pending' THEN
    NEW.finalized_at := pg_catalog.now();
  ELSE
    NEW.finalized_at := OLD.finalized_at;
  END IF;
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    NEW.deleted_at := pg_catalog.now();
    NEW.deleted_by := app.current_actor_user();
  ELSE
    NEW.deleted_by := OLD.deleted_by;
  END IF;
  NEW.updated_by := app.current_actor_user();
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.assets_guard() FROM PUBLIC;
CREATE TRIGGER assets_guard BEFORE INSERT OR UPDATE ON "app"."assets"
  FOR EACH ROW EXECUTE FUNCTION app.assets_guard();

-- =============================================================== row-level security
ALTER TABLE "app"."assets" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

-- Every member reads the project's images (viewers see the library); owners, admins and editors upload, finish,
-- describe and hide them while the workspace is writable and the project editable (the same rule as drafts).
CREATE POLICY tenant_select ON "app"."assets" FOR SELECT TO app_user
  USING (workspace_id = app.current_workspace());
CREATE POLICY editor_insert ON "app"."assets" FOR INSERT TO app_user
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor')
              AND app.project_editable(project_id));
CREATE POLICY editor_update ON "app"."assets" FOR UPDATE TO app_user
  USING (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
         AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor')
         AND app.project_editable(project_id))
  WITH CHECK (workspace_id = app.current_workspace() AND (SELECT app.workspace_writable())
              AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'editor')
              AND app.project_editable(project_id));

-- =============================================================== privileges (least privilege)
GRANT SELECT ON "app"."assets" TO app_user;
-- Prisma sends its own values for defaulted columns; the guard overwrites status, actors and times.
GRANT INSERT (id, workspace_id, project_id, status, file_name, declared_type, declared_bytes, storage_token, alt,
              created_at, updated_at)
  ON "app"."assets" TO app_user;
GRANT UPDATE (status, alt, width, height, variant_widths, variant_bytes, reject_reason, deleted_at)
  ON "app"."assets" TO app_user;
-- No DELETE: a row is the record of what was uploaded (deleting is hiding).
