-- =====================================================================================================
-- P2 S10 (acceptance run 2, findings C-3 and C-10): a preview link row remembers who it was made for, so the
-- "Your preview links" list can say "Sharma Fitness, Indore" and an active link can be copied again. Runs as
-- `migrator` after 20261112120000_p2_s8b_preview_links. Forward-only; rollback is a new migration that drops the
-- two columns and restores the previous guard function.
--
-- The prospect's business name and city are the tenant's own working data: visible only inside the workspace
-- (RLS, unchanged), never in the audit log, never in logs. The token is still not stored; copying a link again
-- re-signs exactly the same claims on the server.
-- =====================================================================================================

ALTER TABLE "app"."template_preview_links"
  ADD COLUMN "prospect_name" TEXT,
  ADD COLUMN "prospect_city" TEXT,
  ADD CONSTRAINT "template_preview_links_prospect_name" CHECK (
    prospect_name IS NULL OR (char_length(btrim(prospect_name)) BETWEEN 1 AND 60 AND prospect_name !~ '[<>]')),
  ADD CONSTRAINT "template_preview_links_prospect_city" CHECK (
    prospect_city IS NULL OR (char_length(btrim(prospect_city)) BETWEEN 1 AND 40 AND prospect_city !~ '[<>]'));

-- Like every other column except the revocation, the new ones cannot change after the link is made.
CREATE OR REPLACE FUNCTION app.template_preview_links_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked preview link cannot change' USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.template_id IS DISTINCT FROM OLD.template_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.personalised IS DISTINCT FROM OLD.personalised
     OR NEW.prospect_name IS DISTINCT FROM OLD.prospect_name OR NEW.prospect_city IS DISTINCT FROM OLD.prospect_city THEN
    RAISE EXCEPTION 'only the revocation of a preview link can change' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

GRANT INSERT (prospect_name, prospect_city) ON "app"."template_preview_links" TO app_user;
