-- P1 S9 (S8-6): the outbox sweep no longer lets failing rows starve healthy ones.
-- The S6 function took the oldest 100 undispatched rows with fewer than 20 attempts. A burst of more than 100 rows
-- that keep failing sat at the head of every sweep and delayed newer, healthy rows by up to 20 sweeps (about 100 min).
-- Rows now sort by attempts first (never tried or least tried first), then by age: a failing row still gets its
-- turns, but only after every row that has not failed as often. Same signature, same guards, same grants.
-- Forward-only; rollback = the S6 definition (ORDER BY o.created_at) in a new migration.
DROP FUNCTION app.outbox_pending(integer, integer);

CREATE FUNCTION app.outbox_pending(p_limit integer, p_min_age_seconds integer)
RETURNS TABLE (id uuid, workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id, o.workspace_id FROM app.outbox_events o
   WHERE app.current_workspace() IS NULL AND app.current_actor_user() IS NULL
     AND o.dispatched_at IS NULL AND o.attempts < 20
     AND o.created_at <= pg_catalog.now() - pg_catalog.make_interval(secs => GREATEST(COALESCE(p_min_age_seconds, 60), 0))
   ORDER BY o.attempts, o.created_at
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 0), 0), 500)
$$;

REVOKE ALL ON FUNCTION app.outbox_pending(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_pending(integer, integer) TO app_user;

GRANT CREATE ON SCHEMA "app" TO svc_definer;
ALTER FUNCTION app.outbox_pending(integer, integer) OWNER TO svc_definer;
REVOKE CREATE ON SCHEMA "app" FROM svc_definer;
