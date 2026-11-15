/**
 * P3 S7a: publishing (FR-PUB-01, FR-PUB-02, FR-PUB-04; module 06; design approved by the Owner 2026-11-15).
 *
 * A publish turns the draft, at the revision the person saw, into an immutable SiteVersion and moves the staging or
 * live pointer to it, in one RLS transaction with its audit row:
 *   1. replay: the same publish key (a UUID the browser makes per click) returns the version it already made;
 *   2. the draft row is locked (FOR UPDATE), so two publishes of one project never interleave and the database's
 *      version number (1, 2, 3 ...) is gap-free;
 *   3. the revision must be the one the person saw, otherwise DRAFT_CONFLICT (they publish what they checked);
 *   4. preflight (preflight.ts) runs on that exact config; a blocking check refuses with PREFLIGHT_BLOCKED;
 *   5. the image URLs the config uses are snapshotted into the version (`assets`), so a published site never
 *      depends on the asset library (hiding an image later does not break a live page);
 *   6. the checksum is SHA-256 over the canonical config and assets;
 *   7. live only: an outbox row makes apps/sites forget the project's cached host answers (decision 5: immediate
 *      invalidation; CDN purge comes with the sites domain, DG-33).
 * Roles (decision 4, Q15): staging = site.publish_staging (owner, admin, editor); live = site.publish (owner,
 * admin). The S1 RLS policies enforce the same rule underneath.
 *
 * Staging links (decision 1): a row in `staging_links` plus a signed token (`/s/<token>` on the preview host). The
 * token is stateless and can be minted again from the row (same claims), so the dashboard can show the link again
 * without storing it. Revoking is final.
 *
 * Audit rows carry ids, kind, number, revision and counts only, never content.
 */
import { createHash } from 'node:crypto';
import type { TenantDatabase, TenantScope, Tx } from '@platform/db';
import { STAGING_TOKEN, mintStagingToken, normalizeHost } from '@platform/hosting';
import type { Logger } from '@platform/logger';
import type { ObjectStorage } from '@platform/providers';
import { type SiteConfig, parseSiteConfig } from '@platform/schema';
import { uuidv7 } from '@platform/db';
import { z } from 'zod';
import { assetIdsIn, variantKey } from './assets';
import { WorkspaceError } from './errors';
import type { ImageWidth } from './image';
import { OUTBOX_EVENTS, type Outbox } from './outbox';
import { type PreflightCheck, type PublishKind, runPreflight } from './preflight';
import { createScopedRunner, parse, requireId } from './scoped';

export const PUBLISH_LIMITS = {
  noteMax: 500,
  /** Approved decision 1. */
  stagingLinkDays: 14,
  /** Active staging links per project; older ones can be turned off. */
  activeStagingLinks: 10,
  /** Versions listed by `status` (S7b adds the full history). */
  recentVersions: 5,
} as const;

/** Where staging links point. Same secret as preview links (domain-separated in the token), same host. */
export interface StagingLinkSettings {
  host: string;
  secret: string;
  previousSecret?: string;
}

export interface PublishingServiceDeps {
  db: TenantDatabase;
  outbox: Outbox;
  logger?: Logger;
  /** The asset storage, for the image URLs a version snapshots; null when uploads are off (no images to snapshot). */
  storage?: () => ObjectStorage | null;
  /** null: staging links are not configured in this environment (no preview host or secret). */
  staging?: StagingLinkSettings | null;
  now?: () => Date;
}

export type VersionAssets = Record<string, Partial<Record<ImageWidth, string>>>;

export interface VersionSummary {
  id: string;
  kind: PublishKind;
  number: number | null;
  note: string | null;
  sourceRevision: number;
  publishedAt: Date;
  publishedBy: string | null;
  publishedByName: string | null;
}

export interface StagingLinkView {
  id: string;
  url: string;
  createdAt: Date;
  expiresAt: Date;
  createdByName: string | null;
}

export interface PublishingStatus {
  draftRevision: number;
  staging: VersionSummary | null;
  live: VersionSummary | null;
  /** The project's site addresses (the live site shows there once the sites domain exists, DG-11/DG-33). */
  hosts: string[];
  stagingLinks: StagingLinkView[];
  stagingLinksConfigured: boolean;
  recent: VersionSummary[];
}

export interface PublishResult {
  versionId: string;
  number: number | null;
  kind: PublishKind;
  /** True when this publish key had already published: nothing new was written. */
  replayed: boolean;
  warnings: number;
}

const kindSchema = z.enum(['staging', 'live']);
const revisionSchema = z.number().int().min(1).max(2_147_483_646);
const keySchema = z.uuid();
const noteSchema = z
  .string()
  .trim()
  .max(PUBLISH_LIMITS.noteMax, `Keep the note under ${PUBLISH_LIMITS.noteMax} characters.`)
  .optional();

/** Key-order-independent JSON for the checksum: the same content always has the same checksum. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function versionChecksum(config: unknown, assets: unknown): string {
  return createHash('sha256').update(canonicalJson({ config, assets })).digest('hex');
}

/** The staging link URL for a row; the same row always gives the same URL. */
export function stagingLinkUrl(
  settings: StagingLinkSettings,
  row: { id: string; createdAt: Date; expiresAt: Date },
): string {
  const token = mintStagingToken(settings.secret, {
    linkId: row.id,
    expiresAt: row.expiresAt,
    now: row.createdAt,
  });
  const local = settings.host.endsWith('localhost');
  return `${local ? 'http' : 'https'}://${settings.host}${local ? ':3001' : ''}/s/${token}`;
}

/** The staging link settings of this environment (PREVIEW_HOST + PREVIEW_TOKEN_SECRET), or null. */
export function stagingSettingsFromEnv(env: Record<string, string | undefined>): StagingLinkSettings | null {
  const host = normalizeHost(env.PREVIEW_HOST);
  const secret = env.PREVIEW_TOKEN_SECRET;
  if (!host || !secret || secret.length < STAGING_TOKEN.minSecretLength) return null;
  const previous = env.PREVIEW_TOKEN_SECRET_PREVIOUS;
  return {
    host,
    secret,
    ...(previous && previous.length >= STAGING_TOKEN.minSecretLength ? { previousSecret: previous } : {}),
  };
}

export function createPublishingService(deps: PublishingServiceDeps) {
  const { command, query } = createScopedRunner(deps.db, deps.logger);
  const now = deps.now ?? (() => new Date());

  async function findProject(tx: Tx, projectId: unknown) {
    const id = requireId(projectId);
    const project = await tx.project.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true, templateId: true },
    });
    if (!project) throw new WorkspaceError('NOT_FOUND');
    return project;
  }

  /** The template's own config, to recognise its demo contact details; null when it is gone from the catalogue. */
  async function templateConfig(tx: Tx, templateId: string | null): Promise<unknown> {
    if (!templateId) return null;
    const rows = await tx.$queryRaw<{ config: unknown }[]>`
      SELECT config FROM app.catalog_template_for_draft(${templateId}::uuid)`;
    return rows[0]?.config ?? null;
  }

  async function snapshotAssets(tx: Tx, config: SiteConfig): Promise<VersionAssets> {
    const ids = [...assetIdsIn(config)].filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 500);
    const storage = deps.storage?.() ?? null;
    const out: VersionAssets = {};
    if (!storage || ids.length === 0) return out;
    const rows = await tx.asset.findMany({
      where: { id: { in: ids }, status: 'ready' },
      select: { id: true, workspaceId: true, storageToken: true, variantWidths: true },
    });
    for (const r of rows) {
      const urls: Partial<Record<ImageWidth, string>> = {};
      for (const w of r.variantWidths as ImageWidth[]) {
        urls[w] = storage.publicUrl(variantKey(r.workspaceId, r.id, r.storageToken, w));
      }
      out[r.id] = urls;
    }
    return out;
  }

  async function names(tx: Tx, ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    if (unique.length === 0) return new Map();
    const rows = await tx.$queryRaw<{ user_id: string; name: string | null }[]>`
      SELECT user_id, name FROM app.workspace_members() WHERE user_id = ANY(${unique}::uuid[])`;
    return new Map(rows.filter((r) => r.name).map((r) => [r.user_id, r.name as string]));
  }

  const versionSelect = {
    id: true,
    kind: true,
    number: true,
    note: true,
    sourceDraftRevision: true,
    createdAt: true,
    createdBy: true,
  } as const;

  type VersionRow = {
    id: string;
    kind: PublishKind;
    number: number | null;
    note: string | null;
    sourceDraftRevision: number;
    createdAt: Date;
    createdBy: string | null;
  };

  const summary = (row: VersionRow, who: Map<string, string>): VersionSummary => ({
    id: row.id,
    kind: row.kind,
    number: row.number,
    note: row.note,
    sourceRevision: row.sourceDraftRevision,
    publishedAt: row.createdAt,
    publishedBy: row.createdBy,
    publishedByName: row.createdBy ? (who.get(row.createdBy) ?? null) : null,
  });

  async function hostsChanged(tx: Tx, scope: TenantScope, projectId: string): Promise<string> {
    const id = uuidv7();
    await tx.outboxEvent.createMany({
      data: [
        {
          id,
          workspaceId: scope.workspaceId,
          event: OUTBOX_EVENTS.siteHostsChanged,
          payload: { workspaceId: scope.workspaceId, projectId },
        },
      ],
    });
    return id;
  }

  return {
    /** What publishing this kind would report now. Any member may look; nothing is written. */
    async preflight(
      actorUserId: string,
      input: { workspaceId: unknown; projectId: unknown; kind: unknown },
    ): Promise<{ revision: number; ok: boolean; checks: PreflightCheck[] }> {
      const kind = parse(kindSchema, input.kind, 'kind');
      return query(actorUserId, input.workspaceId, 'projects.view', async (tx) => {
        const project = await findProject(tx, input.projectId);
        const draft = await tx.siteDraft.findFirst({
          where: { projectId: project.id },
          select: { revision: true, config: true },
        });
        if (!draft) throw new WorkspaceError('NO_DRAFT');
        const result = runPreflight({
          config: draft.config,
          kind,
          template: await templateConfig(tx, project.templateId),
        });
        return { revision: draft.revision, ...result };
      });
    },

    /** FR-PUB-01/02: publish the draft at `expectedRevision` to staging or live. */
    async publish(
      actorUserId: string,
      input: {
        workspaceId: unknown;
        projectId: unknown;
        kind: unknown;
        expectedRevision: unknown;
        publishKey: unknown;
        note?: unknown;
      },
    ): Promise<PublishResult> {
      const kind = parse(kindSchema, input.kind, 'kind');
      const expectedRevision = parse(revisionSchema, input.expectedRevision, 'expectedRevision');
      const publishKey = parse(keySchema, input.publishKey, 'publishKey');
      const note = parse(noteSchema, input.note ?? undefined, 'note') || null;
      const outcome = await command<PublishResult & { outboxIds: string[] }>(
        actorUserId,
        input.workspaceId,
        {
          action: kind === 'live' ? 'site.published_live' : 'site.published_staging',
          capability: kind === 'live' ? 'site.publish' : 'site.publish_staging',
        },
        async (tx, scope) => {
          const project = await findProject(tx, input.projectId);
          if (project.status === 'archived') throw new WorkspaceError('ARCHIVED');
          const replay = await tx.siteVersion.findFirst({
            where: { projectId: project.id, publishKey },
            select: { id: true, kind: true, number: true },
          });
          if (replay) {
            if (replay.kind !== kind) throw new WorkspaceError('IDEMPOTENCY_MISMATCH');
            return {
              result: {
                versionId: replay.id,
                number: replay.number,
                kind,
                replayed: true,
                warnings: 0,
                outboxIds: [],
              },
              audit: null,
            };
          }
          // Serialises publishes of this project (and orders them after any save in flight).
          const locked = await tx.$queryRaw<{ id: string; revision: number }[]>`
            SELECT id, revision FROM app.site_drafts
             WHERE workspace_id = ${scope.workspaceId}::uuid AND project_id = ${project.id}::uuid
             FOR UPDATE`;
          const draftRow = locked[0];
          if (!draftRow) throw new WorkspaceError('NO_DRAFT');
          if (draftRow.revision !== expectedRevision) throw new WorkspaceError('DRAFT_CONFLICT');
          const draft = await tx.siteDraft.findUniqueOrThrow({
            where: { id: draftRow.id },
            select: { config: true },
          });
          const parsed = parseSiteConfig(draft.config);
          const pre = runPreflight({
            config: draft.config,
            kind,
            template: await templateConfig(tx, project.templateId),
          });
          if (!parsed.ok || !pre.ok) {
            const fields: Record<string, string> = {};
            pre.checks
              .filter((c) => c.level === 'blocking')
              .slice(0, 10)
              .forEach((c, i) => {
                fields[`check.${i}`] = c.where ? `${c.where}: ${c.message}` : c.message;
              });
            throw new WorkspaceError('PREFLIGHT_BLOCKED', fields);
          }
          const config = parsed.config;
          const assets = await snapshotAssets(tx, config);
          const version = await tx.siteVersion.create({
            data: {
              workspaceId: scope.workspaceId,
              projectId: project.id,
              kind,
              config,
              assets,
              schemaVersion: config.schemaVersion,
              checksum: versionChecksum(config, assets),
              sourceDraftRevision: expectedRevision,
              note,
              publishKey,
            },
            select: { id: true, number: true },
          });
          await tx.sitePointer.upsert({
            where: {
              workspaceId_projectId_kind: { workspaceId: scope.workspaceId, projectId: project.id, kind },
            },
            create: {
              workspaceId: scope.workspaceId,
              projectId: project.id,
              kind,
              siteVersionId: version.id,
            },
            update: { siteVersionId: version.id },
            select: { id: true },
          });
          const outboxIds = kind === 'live' ? [await hostsChanged(tx, scope, project.id)] : [];
          const warnings = pre.checks.filter((c) => c.level === 'warning').length;
          return {
            result: {
              versionId: version.id,
              number: version.number,
              kind,
              replayed: false,
              warnings,
              outboxIds,
            },
            audit: {
              targetType: 'site_version',
              targetId: version.id,
              projectId: project.id,
              metadata: {
                kind,
                number: version.number,
                draft_revision: expectedRevision,
                warnings,
                images: Object.keys(assets).length,
                has_note: note !== null,
              },
            },
          };
        },
      );
      if (outcome.outboxIds.length)
        await deps.outbox.dispatch(requireId(input.workspaceId), outcome.outboxIds);
      const { outboxIds: _ignored, ...result } = outcome;
      return result;
    },

    /** The publishing panel: current staging and live versions, addresses, staging links, the latest versions. */
    async status(actorUserId: string, workspaceId: unknown, projectId: unknown): Promise<PublishingStatus> {
      return query(actorUserId, workspaceId, 'projects.view', async (tx) => {
        const project = await findProject(tx, projectId);
        const draft = await tx.siteDraft.findFirst({
          where: { projectId: project.id },
          select: { revision: true },
        });
        if (!draft) throw new WorkspaceError('NO_DRAFT');
        const pointers = await tx.sitePointer.findMany({
          where: { projectId: project.id },
          select: { kind: true, siteVersion: { select: versionSelect } },
        });
        const recent = (await tx.siteVersion.findMany({
          where: { projectId: project.id },
          orderBy: { createdAt: 'desc' },
          take: PUBLISH_LIMITS.recentVersions,
          select: versionSelect,
        })) as VersionRow[];
        const domains = await tx.domain.findMany({
          where: { projectId: project.id, deletedAt: null, status: 'active' },
          select: { hostname: true },
          orderBy: { createdAt: 'asc' },
        });
        const links = deps.staging
          ? await tx.stagingLink.findMany({
              where: { projectId: project.id, revokedAt: null, expiresAt: { gt: now() } },
              orderBy: { createdAt: 'desc' },
              take: PUBLISH_LIMITS.activeStagingLinks,
              select: { id: true, createdAt: true, expiresAt: true, createdBy: true },
            })
          : [];
        const pointed = pointers.map((p) => p.siteVersion as VersionRow);
        const who = await names(tx, [
          ...pointed.map((v) => v.createdBy),
          ...recent.map((v) => v.createdBy),
          ...links.map((l) => l.createdBy),
        ]);
        const of = (kind: PublishKind) => {
          const v = pointers.find((p) => p.kind === kind)?.siteVersion as VersionRow | undefined;
          return v ? summary(v, who) : null;
        };
        const staging = deps.staging;
        return {
          draftRevision: draft.revision,
          staging: of('staging'),
          live: of('live'),
          hosts: domains.map((d) => d.hostname),
          stagingLinks: staging
            ? links.map((l) => ({
                id: l.id,
                url: stagingLinkUrl(staging, l),
                createdAt: l.createdAt,
                expiresAt: l.expiresAt,
                createdByName: l.createdBy ? (who.get(l.createdBy) ?? null) : null,
              }))
            : [],
          stagingLinksConfigured: staging !== null && staging !== undefined,
          recent: recent.map((v) => summary(v, who)),
        };
      });
    },

    /** Decision 1: a 14-day link to the project's current staging version. Needs something on staging. */
    async createStagingLink(
      actorUserId: string,
      input: { workspaceId: unknown; projectId: unknown },
    ): Promise<StagingLinkView> {
      const settings = deps.staging;
      if (!settings) throw new WorkspaceError('STAGING_LINKS_NOT_CONFIGURED');
      return command<StagingLinkView>(
        actorUserId,
        input.workspaceId,
        { action: 'staging_link.created', capability: 'site.publish_staging' },
        async (tx, scope) => {
          const project = await findProject(tx, input.projectId);
          if (project.status === 'archived') throw new WorkspaceError('ARCHIVED');
          const pointer = await tx.sitePointer.findFirst({
            where: { projectId: project.id, kind: 'staging' },
            select: { id: true },
          });
          if (!pointer) throw new WorkspaceError('NOT_PUBLISHED');
          const at = now();
          const active = await tx.stagingLink.count({
            where: { projectId: project.id, revokedAt: null, expiresAt: { gt: at } },
          });
          if (active >= PUBLISH_LIMITS.activeStagingLinks) throw new WorkspaceError('RATE_LIMITED');
          // Whole seconds: the token carries epoch seconds and must name the row's exact times.
          const createdAt = new Date(Math.floor(at.getTime() / 1000) * 1000);
          const expiresAt = new Date(createdAt.getTime() + PUBLISH_LIMITS.stagingLinkDays * 86_400_000);
          const row = await tx.stagingLink.create({
            data: { workspaceId: scope.workspaceId, projectId: project.id, createdAt, expiresAt },
            select: { id: true, createdAt: true, expiresAt: true },
          });
          return {
            result: { ...row, url: stagingLinkUrl(settings, row), createdByName: null },
            audit: {
              targetType: 'staging_link',
              targetId: row.id,
              projectId: project.id,
              metadata: { days: PUBLISH_LIMITS.stagingLinkDays },
            },
          };
        },
      );
    },

    /** Turns a staging link off for good. Allowed in a suspended workspace (protective). */
    async revokeStagingLink(
      actorUserId: string,
      input: { workspaceId: unknown; linkId: unknown },
    ): Promise<{ revoked: boolean }> {
      const linkId = requireId(input.linkId);
      return command<{ revoked: boolean }>(
        actorUserId,
        input.workspaceId,
        { action: 'staging_link.revoked', capability: 'site.publish_staging', requireWritable: false },
        async (tx, scope) => {
          const link = await tx.stagingLink.findFirst({
            where: { id: linkId },
            select: { id: true, projectId: true, revokedAt: true },
          });
          if (!link) throw new WorkspaceError('NOT_FOUND');
          if (link.revokedAt) return { result: { revoked: false }, audit: null };
          await tx.stagingLink.update({
            where: { id: link.id },
            data: { revokedAt: now(), revokedBy: scope.actorUserId },
            select: { id: true },
          });
          return {
            result: { revoked: true },
            audit: { targetType: 'staging_link', targetId: link.id, projectId: link.projectId },
          };
        },
      );
    },
  };
}

export type PublishingService = ReturnType<typeof createPublishingService>;
