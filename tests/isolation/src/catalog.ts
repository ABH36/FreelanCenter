/**
 * Automatic discovery from the PostgreSQL catalog (SRS 5.3 item 5). pg_catalog, not information_schema: the
 * latter lists only objects the inspecting role has privileges on (S1 finding S1-5), and platform_admin has none.
 */
import type pg from 'pg';

/** Roles that own product objects; a relation owned by one of them, or in a schema one of them owns, is ours. */
const PRODUCT_OWNERS = ['migrator', 'svc_definer'];

export interface Relation {
  /** `schema.name` */
  qualified: string;
  schema: string;
  name: string;
  /** pg_class.relkind: r table, p partitioned, v view, m materialized view, f foreign table */
  kind: string;
  hasWorkspaceId: boolean;
  workspaceIdNullable: boolean;
}

export async function productRelations(admin: pg.Pool): Promise<Relation[]> {
  const { rows } = await admin.query<{
    schema: string;
    name: string;
    kind: string;
    has_workspace_id: boolean;
    nullable: boolean;
  }>(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
            a.attname IS NOT NULL AS has_workspace_id, COALESCE(NOT a.attnotnull, false) AS nullable
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (pg_get_userbyid(c.relowner) = ANY($1) OR pg_get_userbyid(n.nspowner) = ANY($1)
             OR n.nspname IN ('app', 'identity'))
      ORDER BY 1, 2`,
    [PRODUCT_OWNERS],
  );
  return rows.map((r) => ({
    qualified: `${r.schema}.${r.name}`,
    schema: r.schema,
    name: r.name,
    kind: r.kind,
    hasWorkspaceId: r.has_workspace_id,
    workspaceIdNullable: r.nullable,
  }));
}

export interface ForeignKey {
  name: string;
  child: string;
  childColumns: string[];
  parentSchema: string;
  parent: string;
  parentColumns: string[];
}

/** Every foreign key declared on a table in schema `app`, with its column lists in key order. */
export async function appForeignKeys(admin: pg.Pool): Promise<ForeignKey[]> {
  const { rows } = await admin.query<{
    name: string;
    child: string;
    child_columns: string[];
    parent_schema: string;
    parent: string;
    parent_columns: string[];
  }>(
    `SELECT k.conname AS name, cc.relname AS child, pn.nspname AS parent_schema, pc.relname AS parent,
            ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum ORDER BY u.ord) AS child_columns,
            ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.attnum ORDER BY u.ord) AS parent_columns
       FROM pg_constraint k
       JOIN pg_class cc ON cc.oid = k.conrelid JOIN pg_namespace cn ON cn.oid = cc.relnamespace
       JOIN pg_class pc ON pc.oid = k.confrelid JOIN pg_namespace pn ON pn.oid = pc.relnamespace
      WHERE k.contype = 'f' AND cn.nspname = 'app'
      ORDER BY 1`,
  );
  return rows.map((r) => ({
    name: r.name,
    child: r.child,
    childColumns: r.child_columns,
    parentSchema: r.parent_schema,
    parent: r.parent,
    parentColumns: r.parent_columns,
  }));
}
