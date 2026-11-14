/**
 * P3 S2: the draft service (module 05; FR-PRJ-01, FR-BLD-06, FR-BLD-07; design approved by the Owner 2026-11-14).
 *
 * Builds on the S1 data model, whose rules the database enforces on its own (revision +1, forward-only change sets,
 * lock holder and times). This service adds what the database cannot know:
 *   - every change is a `PatchOperation[]` validated by `applyPatch` (the whole SiteConfig must stay valid);
 *   - every applied change stores its inverse: a server-made snapshot of the parts it touched (business, theme, a
 *     page's title/SEO, a page's sections). Clients never send inverse operations;
 *   - undo/redo is one stack per project, at most `BUILDER_LIMITS.undoDepth` changes deep (approved decision 2);
 *   - saving, undo/redo and accepting a proposal need the caller to hold the project's edit lock (decision 1);
 *   - a browser-generated change id makes a retried save idempotent.
 * Audit rows carry ids and counts only, never content.
 */
import type { TenantDatabase, TenantScope, Tx } from '@platform/db';
import type { Logger } from '@platform/logger';
import {
  type ConfigIssue,
  type SiteConfig,
  applyPatch,
  parseSiteConfig,
  patchSchema,
} from '@platform/schema';
import { z } from 'zod';
import { WorkspaceError } from './errors';
import { type AuditEntry, createScopedRunner, parse, requireId } from './scoped';

export const BUILDER_LIMITS = {
  /** Approved 2026-11-14: undo reaches the last 50 changes of a project. */
  undoDepth: 50,
  /** Change sets read to work out undo/redo; comfortably more than undoDepth plus the undo records between. */
  historyWindow: 200,
  /** The database's own limit on `change_sets.inverse` (migration P3 S1). */
  inverseMaxBytes: 262_144,
} as const;

type Page = SiteConfig['pages'][number];

/** Server-made inverse operations: restore a part of the config to a snapshot. Never accepted from a client. */
export type RestoreOperation =
  | { op: 'restoreBusiness'; value: SiteConfig['business'] }
  | { op: 'restoreTheme'; value: SiteConfig['theme'] }
  | { op: 'restorePage'; pageId: string; title: string; seo: Page['seo'] | null }
  | { op: 'restoreSections'; pageId: string; sections: Page['sections'] };

type Part = 'business' | 'theme' | `page:${string}` | `sections:${string}`;

function pageOfSection(config: SiteConfig, sectionId: string): string | null {
  for (const page of config.pages) if (page.sections.some((s) => s.id === sectionId)) return page.id;
  return null;
}

/** The parts of the config a list of operations (patch or restore) can change. */
export function touchedParts(before: SiteConfig, after: SiteConfig, ops: readonly unknown[]): Part[] {
  const parts = new Set<Part>();
  for (const raw of ops) {
    const op = raw as { op: string; pageId?: string; sectionId?: string };
    switch (op.op) {
      case 'updateBusiness':
      case 'restoreBusiness':
        parts.add('business');
        break;
      case 'updateTheme':
      case 'restoreTheme':
        parts.add('theme');
        break;
      case 'updatePage':
      case 'restorePage':
        parts.add(`page:${op.pageId}`);
        break;
      case 'addSection':
      case 'restoreSections':
        parts.add(`sections:${op.pageId}`);
        break;
      default: {
        // updateSection, removeSection, moveSection: the page that held the section before (or holds it now,
        // for a section that an earlier operation of the same patch added).
        const pageId =
          (op.sectionId && (pageOfSection(before, op.sectionId) ?? pageOfSection(after, op.sectionId))) ||
          null;
        if (pageId) parts.add(`sections:${pageId}`);
      }
    }
  }
  return [...parts];
}

/** The operations that put `parts` back to how they are in `before`. */
export function inverseFor(before: SiteConfig, parts: readonly Part[]): RestoreOperation[] {
  const out: RestoreOperation[] = [];
  for (const part of parts) {
    if (part === 'business') out.push({ op: 'restoreBusiness', value: structuredClone(before.business) });
    else if (part === 'theme') out.push({ op: 'restoreTheme', value: structuredClone(before.theme) });
    else {
      const [kind, pageId] = part.split(':') as ['page' | 'sections', string];
      const page = before.pages.find((p) => p.id === pageId);
      if (!page) continue; // pages are never added or removed by a patch
      out.push(
        kind === 'page'
          ? { op: 'restorePage', pageId, title: page.title, seo: structuredClone(page.seo) ?? null }
          : { op: 'restoreSections', pageId, sections: structuredClone(page.sections) },
      );
    }
  }
  return out;
}

/** Applies server-made restore operations; the result must be a valid SiteConfig like any other change. */
export function applyRestore(
  current: SiteConfig,
  ops: readonly RestoreOperation[],
): { ok: true; config: SiteConfig } | { ok: false; issues: readonly ConfigIssue[] } {
  const draft = structuredClone(current);
  for (const op of ops) {
    if (op.op === 'restoreBusiness') draft.business = structuredClone(op.value);
    else if (op.op === 'restoreTheme') draft.theme = structuredClone(op.value);
    else {
      const page = draft.pages.find((p) => p.id === op.pageId);
      if (!page) return { ok: false, issues: [{ path: '', message: 'Unknown page' }] };
      if (op.op === 'restoreSections') page.sections = structuredClone(op.sections);
      else {
        page.title = op.title;
        if (op.seo === null) delete (page as { seo?: unknown }).seo;
        else page.seo = structuredClone(op.seo);
      }
    }
  }
  const parsed = parseSiteConfig(draft);
  return parsed.ok ? { ok: true, config: parsed.config } : parsed;
}

/** Key-order-independent JSON, so a retried request is recognised whatever order JSONB stored its keys in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function issuesToFields(issues: readonly ConfigIssue[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues.slice(0, 10)) fields[issue.path || 'config'] ??= issue.message;
  return fields;
}

const revisionSchema = z.number().int().min(1).max(2_147_483_646);
const summarySchema = z.string().trim().max(500).optional();

export interface LockState {
  holderUserId: string;
  expiresAt: Date;
  /** The caller holds it. */
  mine: boolean;
}

export interface DraftView {
  projectId: string;
  revision: number;
  config: SiteConfig;
  templateId: string | null;
  lock: LockState | null;
  canUndo: boolean;
  canRedo: boolean;
}

interface HistoryRow {
  id: string;
  status: 'proposed' | 'applied' | 'rejected' | 'undone';
  undoesId: string | null;
  resultRevision: number | null;
  inverse: unknown;
}

export interface BuilderServiceDeps {
  db: TenantDatabase;
  logger?: Logger;
}

export function createBuilderService(deps: BuilderServiceDeps) {
  const runner = createScopedRunner(deps.db, deps.logger);
  const { command, query } = runner;

  async function findProject(tx: Tx, projectId: unknown) {
    const id = requireId(projectId);
    const project = await tx.project.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true, templateId: true },
    });
    if (!project) throw new WorkspaceError('NOT_FOUND');
    return project;
  }

  async function editableProject(tx: Tx, projectId: unknown) {
    const project = await findProject(tx, projectId);
    if (project.status === 'archived') throw new WorkspaceError('ARCHIVED');
    return project;
  }

  async function loadDraft(tx: Tx, scope: TenantScope, projectId: string) {
    const draft = await tx.siteDraft.findUnique({
      where: { workspaceId_projectId: { workspaceId: scope.workspaceId, projectId } },
      select: { id: true, revision: true, config: true },
    });
    if (!draft) throw new WorkspaceError('NO_DRAFT');
    const parsed = parseSiteConfig(draft.config);
    // A stored draft was valid when written; failing now means a schema migration is missing (an operator bug).
    if (!parsed.ok) throw new Error(`draft ${draft.id} no longer parses as a SiteConfig`);
    return { id: draft.id, revision: draft.revision, config: parsed.config };
  }

  async function lockState(tx: Tx, scope: TenantScope, projectId: string): Promise<LockState | null> {
    const lock = await tx.projectEditLock.findUnique({
      where: { workspaceId_projectId: { workspaceId: scope.workspaceId, projectId } },
      select: { holderUserId: true, expiresAt: true },
    });
    if (!lock || lock.expiresAt.getTime() <= Date.now()) return null;
    return { ...lock, mine: lock.holderUserId === scope.actorUserId };
  }

  async function requireLock(tx: Tx, scope: TenantScope, projectId: string) {
    const lock = await lockState(tx, scope, projectId);
    if (!lock?.mine) throw new WorkspaceError('LOCK_REQUIRED');
  }

  /** The recent history with each row's direction: even = a change or a redo, odd = an undo record. */
  async function history(tx: Tx, projectId: string) {
    const select = { id: true, status: true, undoesId: true, resultRevision: true, inverse: true } as const;
    const rows: HistoryRow[] = await tx.changeSet.findMany({
      where: { projectId, status: { in: ['applied', 'undone'] } },
      orderBy: { resultRevision: 'desc' },
      take: BUILDER_LIMITS.historyWindow,
      select,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    // An undo record can point past the window; fetch those parents (bounded by the depth of a chain).
    for (let guard = 0; guard < 20; guard++) {
      const missing = rows
        .flatMap((r) => (r.undoesId && !byId.has(r.undoesId) ? [r.undoesId] : []))
        .filter((id, i, all) => all.indexOf(id) === i);
      if (missing.length === 0) break;
      for (const row of await tx.changeSet.findMany({ where: { id: { in: missing } }, select })) {
        byId.set(row.id, row);
      }
    }
    const parity = new Map<string, number>();
    const parityOf = (row: HistoryRow, depth = 0): number => {
      const known = parity.get(row.id);
      if (known !== undefined) return known;
      const parent = row.undoesId ? byId.get(row.undoesId) : undefined;
      const value = row.undoesId && parent && depth < 1000 ? 1 - parityOf(parent, depth + 1) : 0;
      parity.set(row.id, value);
      return value;
    };
    const changes = rows.filter((r) => parityOf(r) === 0);
    const undoRecords = rows.filter((r) => parityOf(r) === 1);
    const latestFresh = Math.max(
      0,
      ...rows.filter((r) => r.undoesId === null).map((r) => r.resultRevision ?? 0),
    );
    const undoIndex = changes.findIndex((r) => r.status === 'applied');
    const undoTarget = undoIndex >= 0 ? changes[undoIndex]! : null;
    const redoTarget =
      undoRecords.find((r) => r.status === 'applied' && (r.resultRevision ?? 0) > latestFresh) ?? null;
    return { undoTarget, undoIndex, redoTarget };
  }

  /** Writes a new revision of the draft and its change set in the caller's transaction. */
  async function commitChange(
    tx: Tx,
    scope: TenantScope,
    input: {
      projectId: string;
      draftId: string;
      revision: number;
      before: SiteConfig;
      after: SiteConfig;
      operations: readonly unknown[];
      changeId?: string;
      undoesId?: string;
      source?: 'manual' | 'ai' | 'client';
      summary?: string;
    },
  ) {
    const inverse = inverseFor(input.before, touchedParts(input.before, input.after, input.operations));
    if (Buffer.byteLength(JSON.stringify(inverse)) > BUILDER_LIMITS.inverseMaxBytes) {
      throw new WorkspaceError('CHANGE_TOO_LARGE');
    }
    const saved = await tx.siteDraft.updateMany({
      where: { id: input.draftId, revision: input.revision },
      data: { config: input.after, schemaVersion: input.after.schemaVersion, revision: input.revision + 1 },
    });
    if (saved.count !== 1) throw new WorkspaceError('DRAFT_CONFLICT');
    const changeSet = await tx.changeSet.create({
      data: {
        ...(input.changeId ? { id: input.changeId } : {}),
        workspaceId: scope.workspaceId,
        projectId: input.projectId,
        source: input.source ?? 'manual',
        status: 'applied',
        operations: input.operations as object[],
        inverse,
        summary: input.summary ?? null,
        baseRevision: input.revision,
        resultRevision: input.revision + 1,
        undoesId: input.undoesId ?? null,
      },
      select: { id: true },
    });
    return { changeSetId: changeSet.id, revision: input.revision + 1 };
  }

  const audit = (projectId: string, metadata: AuditEntry['metadata']): AuditEntry => ({
    targetType: 'project',
    targetId: projectId,
    projectId,
    ...(metadata ? { metadata } : {}),
  });

  return {
    /**
     * FR-PRJ-01: start the project's site from a catalogue template (its latest published version). Repeating it
     * with the same template returns the existing draft; another template while a draft exists is DRAFT_EXISTS
     * (switching templates is a later slice).
     */
    async createDraftFromTemplate(
      actorUserId: string,
      input: { workspaceId: unknown; projectId: unknown; templateId: unknown },
    ): Promise<{ revision: number; created: boolean }> {
      const templateId = requireId(input.templateId);
      return command<{ revision: number; created: boolean }>(
        actorUserId,
        input.workspaceId,
        { action: 'draft.created', capability: 'draft.edit' },
        async (tx, scope) => {
          const project = await editableProject(tx, input.projectId);
          const existing = await tx.siteDraft.findUnique({
            where: { workspaceId_projectId: { workspaceId: scope.workspaceId, projectId: project.id } },
            select: { revision: true },
          });
          if (existing) {
            if (project.templateId !== templateId) throw new WorkspaceError('DRAFT_EXISTS');
            return { result: { revision: existing.revision, created: false }, audit: null };
          }
          const [template] = await tx.$queryRaw<
            { version_id: string; version: number; config: unknown }[]
          >`SELECT version_id, version, config FROM app.catalog_template_for_draft(${templateId}::uuid)`;
          if (!template) throw new WorkspaceError('NOT_FOUND');
          const parsed = parseSiteConfig(template.config);
          if (!parsed.ok) throw new Error(`catalogue template ${templateId} does not parse as a SiteConfig`);
          await tx.siteDraft.create({
            data: {
              workspaceId: scope.workspaceId,
              projectId: project.id,
              config: parsed.config,
              schemaVersion: parsed.config.schemaVersion,
              basedOnTemplateVersionId: template.version_id,
            },
            select: { id: true },
          });
          await tx.project.update({
            where: { id: project.id },
            data: { templateId, templateVersionId: template.version_id },
            select: { id: true },
          });
          return {
            result: { revision: 1, created: true },
            audit: audit(project.id, { templateId, templateVersion: template.version }),
          };
        },
      );
    },

    /** The draft, who is editing and whether undo/redo are available. Any member may read. */
    async getDraft(actorUserId: string, workspaceId: unknown, projectId: unknown): Promise<DraftView> {
      return query(actorUserId, workspaceId, 'projects.view', async (tx, scope) => {
        const project = await findProject(tx, projectId);
        const draft = await loadDraft(tx, scope, project.id);
        const { undoTarget, undoIndex, redoTarget } = await history(tx, project.id);
        return {
          projectId: project.id,
          revision: draft.revision,
          config: draft.config,
          templateId: project.templateId,
          lock: await lockState(tx, scope, project.id),
          canUndo: undoTarget !== null && undoIndex < BUILDER_LIMITS.undoDepth,
          canRedo: redoTarget !== null,
        };
      });
    },

    /**
     * FR-BLD-06: save one edit. `expectedRevision` is the revision the editor started from; anything else is
     * DRAFT_CONFLICT (no last-write-wins). `changeId` (a UUID made by the browser) makes a retry idempotent.
     */
    async applyChange(
      actorUserId: string,
      input: {
        workspaceId: unknown;
        projectId: unknown;
        changeId: unknown;
        expectedRevision: unknown;
        operations: unknown;
      },
    ): Promise<{ revision: number }> {
      const changeId = requireId(input.changeId);
      const expected = parse(revisionSchema, input.expectedRevision, 'expectedRevision');
      const operations = parse(patchSchema, input.operations, 'operations');
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'draft.changed', capability: 'draft.edit' },
        async (tx, scope) => {
          const project = await editableProject(tx, input.projectId);
          const previous = await tx.changeSet.findUnique({
            where: { id: changeId },
            select: { projectId: true, baseRevision: true, operations: true, resultRevision: true },
          });
          if (previous) {
            const same =
              previous.projectId === project.id &&
              previous.baseRevision === expected &&
              canonical(previous.operations) === canonical(operations);
            if (!same || previous.resultRevision === null) throw new WorkspaceError('IDEMPOTENCY_MISMATCH');
            return { result: { revision: previous.resultRevision }, audit: null };
          }
          await requireLock(tx, scope, project.id);
          const draft = await loadDraft(tx, scope, project.id);
          if (draft.revision !== expected) throw new WorkspaceError('DRAFT_CONFLICT');
          const patched = applyPatch(draft.config, operations);
          if (!patched.ok) throw new WorkspaceError('INVALID_INPUT', issuesToFields(patched.issues));
          const { changeSetId, revision } = await commitChange(tx, scope, {
            projectId: project.id,
            draftId: draft.id,
            revision: draft.revision,
            before: draft.config,
            after: patched.config,
            operations,
            changeId,
          });
          return {
            result: { revision },
            audit: audit(project.id, { changeSetId, operations: operations.length, revision }),
          };
        },
      );
    },

    /** Undo the project's latest change (any author: one editor at a time holds the lock). */
    async undo(
      actorUserId: string,
      input: { workspaceId: unknown; projectId: unknown; expectedRevision: unknown },
    ) {
      return reverse(actorUserId, input, 'undo');
    },

    /** Redo the latest undone change, as long as no new change was made after the undo. */
    async redo(
      actorUserId: string,
      input: { workspaceId: unknown; projectId: unknown; expectedRevision: unknown },
    ) {
      return reverse(actorUserId, input, 'redo');
    },

    /**
     * Store a proposal (source `ai` or `client`) without touching the draft. It must apply cleanly to the draft at
     * `baseRevision`. P4 (AI) and P5 (client onboarding) call this; a member decides with accept/reject.
     */
    async proposeChange(
      actorUserId: string,
      input: {
        workspaceId: unknown;
        projectId: unknown;
        source: unknown;
        baseRevision: unknown;
        operations: unknown;
        summary?: unknown;
      },
    ): Promise<{ changeSetId: string }> {
      const source = parse(z.enum(['ai', 'client']), input.source, 'source');
      const base = parse(revisionSchema, input.baseRevision, 'baseRevision');
      const operations = parse(patchSchema, input.operations, 'operations');
      const summary = parse(summarySchema, input.summary ?? undefined, 'summary');
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'draft.change.proposed', capability: 'draft.edit' },
        async (tx, scope) => {
          const project = await editableProject(tx, input.projectId);
          const draft = await loadDraft(tx, scope, project.id);
          if (draft.revision !== base) throw new WorkspaceError('DRAFT_CONFLICT');
          const patched = applyPatch(draft.config, operations);
          if (!patched.ok) throw new WorkspaceError('INVALID_INPUT', issuesToFields(patched.issues));
          const created = await tx.changeSet.create({
            data: {
              workspaceId: scope.workspaceId,
              projectId: project.id,
              source,
              status: 'proposed',
              operations: operations as object[],
              summary: summary ?? null,
              baseRevision: base,
            },
            select: { id: true },
          });
          return {
            result: { changeSetId: created.id },
            audit: audit(project.id, { changeSetId: created.id, source, operations: operations.length }),
          };
        },
      );
    },

    /** Apply a proposal. Only on the revision it was made for: a later draft needs a new proposal. */
    async acceptProposal(
      actorUserId: string,
      input: { workspaceId: unknown; projectId: unknown; changeSetId: unknown },
    ) {
      const changeSetId = requireId(input.changeSetId);
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'draft.change.accepted', capability: 'draft.edit' },
        async (tx, scope) => {
          const project = await editableProject(tx, input.projectId);
          const proposal = await tx.changeSet.findFirst({
            where: { id: changeSetId, projectId: project.id, status: 'proposed' },
            select: { id: true, operations: true, baseRevision: true },
          });
          if (!proposal) throw new WorkspaceError('NOT_FOUND');
          await requireLock(tx, scope, project.id);
          const draft = await loadDraft(tx, scope, project.id);
          if (draft.revision !== proposal.baseRevision) throw new WorkspaceError('PROPOSAL_STALE');
          const patched = applyPatch(draft.config, proposal.operations);
          if (!patched.ok) throw new WorkspaceError('PROPOSAL_STALE');
          const inverse = inverseFor(
            draft.config,
            touchedParts(draft.config, patched.config, proposal.operations as unknown[]),
          );
          const saved = await tx.siteDraft.updateMany({
            where: { id: draft.id, revision: draft.revision },
            data: {
              config: patched.config,
              schemaVersion: patched.config.schemaVersion,
              revision: draft.revision + 1,
            },
          });
          if (saved.count !== 1) throw new WorkspaceError('DRAFT_CONFLICT');
          await tx.changeSet.update({
            where: { id: proposal.id },
            data: { status: 'applied', inverse, resultRevision: draft.revision + 1 },
            select: { id: true },
          });
          return {
            result: { revision: draft.revision + 1 },
            audit: audit(project.id, { changeSetId: proposal.id, revision: draft.revision + 1 }),
          };
        },
      );
    },

    async rejectProposal(
      actorUserId: string,
      input: { workspaceId: unknown; projectId: unknown; changeSetId: unknown },
    ) {
      const changeSetId = requireId(input.changeSetId);
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'draft.change.rejected', capability: 'draft.edit' },
        async (tx) => {
          const project = await editableProject(tx, input.projectId);
          const done = await tx.changeSet.updateMany({
            where: { id: changeSetId, projectId: project.id, status: 'proposed' },
            data: { status: 'rejected' },
          });
          if (done.count !== 1) throw new WorkspaceError('NOT_FOUND');
          return { result: undefined, audit: audit(project.id, { changeSetId }) };
        },
      );
    },

    /**
     * FR-BLD-07: take the edit lock if it is free, expired or already the caller's (the heartbeat calls this every
     * 30 s). Someone else's live lock is reported, not taken: `{ held: false, lock }`.
     */
    async acquireLock(
      actorUserId: string,
      input: { workspaceId: unknown; projectId: unknown },
    ): Promise<{ held: boolean; lock: LockState | null }> {
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'draft.lock.acquired', capability: 'draft.edit' },
        async (tx, scope) => {
          const project = await editableProject(tx, input.projectId);
          const current = await lockState(tx, scope, project.id);
          if (current && !current.mine) return { result: { held: false, lock: current }, audit: null };
          const data = {
            workspaceId: scope.workspaceId,
            projectId: project.id,
            holderUserId: scope.actorUserId,
            expiresAt: new Date(Date.now() + 120_000),
          };
          // Free (no row) or ours/expired (a row): insert-or-renew; the database sets holder and times.
          await tx.projectEditLock.createMany({ data, skipDuplicates: true });
          await tx.projectEditLock.updateMany({
            where: { projectId: project.id },
            data: { holderUserId: scope.actorUserId },
          });
          const after = await lockState(tx, scope, project.id);
          return { result: { held: after?.mine === true, lock: after }, audit: null };
        },
      );
    },

    /** Owners and admins may take a live lock over (approved 2026-11-14); audited with the previous holder. */
    async takeOverLock(actorUserId: string, input: { workspaceId: unknown; projectId: unknown }) {
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'draft.lock.taken_over', capability: 'draft.edit' },
        async (tx, scope) => {
          if (scope.role !== 'owner' && scope.role !== 'admin') throw new WorkspaceError('FORBIDDEN');
          const project = await editableProject(tx, input.projectId);
          const previous = await lockState(tx, scope, project.id);
          await tx.projectEditLock.createMany({
            data: {
              workspaceId: scope.workspaceId,
              projectId: project.id,
              holderUserId: scope.actorUserId,
              expiresAt: new Date(Date.now() + 120_000),
            },
            skipDuplicates: true,
          });
          await tx.projectEditLock.updateMany({
            where: { projectId: project.id },
            data: { holderUserId: scope.actorUserId },
          });
          return {
            result: { held: true },
            audit: audit(project.id, {
              previousHolder: previous && !previous.mine ? previous.holderUserId : null,
            }),
          };
        },
      );
    },

    /** Leaving the editor. Only the caller's own lock is released. */
    async releaseLock(actorUserId: string, input: { workspaceId: unknown; projectId: unknown }) {
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'draft.lock.released', capability: 'draft.edit', requireWritable: false },
        async (tx, scope) => {
          const project = await findProject(tx, input.projectId);
          await tx.projectEditLock.deleteMany({
            where: { projectId: project.id, holderUserId: scope.actorUserId },
          });
          return { result: undefined, audit: null };
        },
      );
    },
  };

  async function reverse(
    actorUserId: string,
    input: { workspaceId: unknown; projectId: unknown; expectedRevision: unknown },
    direction: 'undo' | 'redo',
  ): Promise<{ revision: number }> {
    const expected = parse(revisionSchema, input.expectedRevision, 'expectedRevision');
    return command(
      actorUserId,
      input.workspaceId,
      { action: direction === 'undo' ? 'draft.undone' : 'draft.redone', capability: 'draft.edit' },
      async (tx, scope) => {
        const project = await editableProject(tx, input.projectId);
        await requireLock(tx, scope, project.id);
        const draft = await loadDraft(tx, scope, project.id);
        if (draft.revision !== expected) throw new WorkspaceError('DRAFT_CONFLICT');
        const { undoTarget, undoIndex, redoTarget } = await history(tx, project.id);
        const target = direction === 'undo' ? undoTarget : redoTarget;
        if (!target) throw new WorkspaceError(direction === 'undo' ? 'NOTHING_TO_UNDO' : 'NOTHING_TO_REDO');
        if (direction === 'undo' && undoIndex >= BUILDER_LIMITS.undoDepth)
          throw new WorkspaceError('UNDO_LIMIT');
        const restore = target.inverse as RestoreOperation[];
        const restored = applyRestore(draft.config, restore);
        // A restore can only fail if the schema changed under the history; refuse rather than corrupt.
        if (!restored.ok) throw new WorkspaceError('INVALID_INPUT', issuesToFields(restored.issues));
        const { changeSetId, revision } = await commitChange(tx, scope, {
          projectId: project.id,
          draftId: draft.id,
          revision: draft.revision,
          before: draft.config,
          after: restored.config,
          operations: restore,
          undoesId: target.id,
        });
        await tx.changeSet.update({
          where: { id: target.id },
          data: { status: 'undone' },
          select: { id: true },
        });
        return {
          result: { revision },
          audit: audit(project.id, { changeSetId, reverses: target.id, revision }),
        };
      },
    );
  }
}

export type BuilderService = ReturnType<typeof createBuilderService>;
