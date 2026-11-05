/**
 * Templates in the dashboard (module 04, P2 S6b; FR-TPL-09): browse the catalogue and make a shareable preview link
 * for a prospect. Both commands follow the scoped pattern (`scoped.ts`): membership -> capability -> lookup ->
 * mutation + audit in one RLS transaction. Making a link needs `templates.preview` (owners, admins and editors) in a
 * writable workspace and leaves an audit row; the link itself is signed with the preview secret (packages/hosting),
 * which only the server holds.
 *
 * What is audited: the template, the number of days and whether the link is personalised. Never the link, the token
 * or the prospect's name.
 */
import type { Capability } from '@platform/auth/rbac';
import type { TenantDatabase, Tx } from '@platform/db';
import { isValidProspectName, mintPreviewToken, normalizeHost, PREVIEW_TOKEN } from '@platform/hosting';
import type { Logger } from '@platform/logger';
import { z } from 'zod';
import { WorkspaceError } from './errors';
import { createScopedRunner, parse, requireId } from './scoped';

/** SEC-09-style abuse limit (placeholder until plans, P6): links one person may make per day. */
export const TEMPLATE_LIMITS = { previewLinksPerDay: 100 } as const;

export const PREVIEW_DAYS = [1, 3, 7, 14, 30] as const;

export interface PreviewSettings {
  /** The preview host, for example `preview.sites.example.com` (no scheme, no port). */
  host: string;
  /** The signing secret (32 or more characters). Never leaves the server. */
  secret: string;
}

/**
 * The preview settings of this environment, or null when previews are not configured: `PREVIEW_HOST` (a valid host
 * name) and `PREVIEW_TOKEN_SECRET` (32 or more characters). The same two values apps/sites verifies links with.
 */
export function previewSettingsFromEnv(env: Record<string, string | undefined>): PreviewSettings | null {
  const host = normalizeHost(env.PREVIEW_HOST);
  const secret = env.PREVIEW_TOKEN_SECRET;
  return host && secret && secret.length >= PREVIEW_TOKEN.minSecretLength ? { host, secret } : null;
}

export interface TemplateServiceDeps {
  db: TenantDatabase;
  /** `null` or missing: previews are not configured in this environment. */
  preview: PreviewSettings | null;
  logger?: Logger;
  linksPerDay?: number;
  now?: () => Date;
}

export interface CatalogEntry {
  templateId: string;
  slug: string;
  name: string;
  category: string;
  description: string;
  version: number;
}

export interface PreviewLink {
  url: string;
  expiresAt: string;
  templateName: string;
}

const input = z.object({
  templateId: z.unknown(),
  prospectName: z.string().trim().max(200).optional(),
  days: z.coerce.number().int(),
});

const ACTION = 'template.preview_link.created';
const CAPABILITY: Capability = 'templates.preview';

export function createTemplateService(deps: TemplateServiceDeps) {
  const { db, preview, logger } = deps;
  const perDay = deps.linksPerDay ?? TEMPLATE_LIMITS.previewLinksPerDay;
  const now = deps.now ?? (() => new Date());
  const runner = createScopedRunner(db, logger);

  async function catalogRows(tx: Tx): Promise<CatalogEntry[]> {
    const rows = await tx.$queryRaw<
      {
        template_id: string;
        slug: string;
        name: string;
        category: string;
        description: string;
        version: number;
      }[]
    >`SELECT template_id, slug, name, category, description, version FROM app.list_catalog_templates()`;
    return rows.map((r) => ({
      templateId: r.template_id,
      slug: r.slug,
      name: r.name,
      category: r.category,
      description: r.description,
      version: r.version,
    }));
  }

  return {
    /** Whether links can be made in this environment (the page explains when they cannot). */
    previewsConfigured: preview !== null,

    /** The published templates (platform built-ins; marketplace ones from P6). Any member may browse. */
    catalog(actorUserId: string, workspaceId: unknown): Promise<CatalogEntry[]> {
      return runner.query(actorUserId, workspaceId, 'projects.view', (tx) => catalogRows(tx));
    },

    /**
     * FR-TPL-09: a signed, expiring link to the template with demo data, optionally showing the prospect's business
     * name. Same NOT_FOUND for an unknown, unpublished or foreign template.
     */
    createPreviewLink(
      actorUserId: string,
      raw: { workspaceId: unknown; templateId: unknown; prospectName?: unknown; days: unknown },
    ): Promise<PreviewLink> {
      return runner.command<PreviewLink>(
        actorUserId,
        raw.workspaceId,
        { action: ACTION, capability: CAPABILITY },
        async (tx, scope) => {
          if (!preview) throw new WorkspaceError('PREVIEWS_NOT_CONFIGURED');
          const v = parse(input, raw, 'preview');
          const templateId = requireId(v.templateId);
          const days = v.days;
          if (!(PREVIEW_DAYS as readonly number[]).includes(days)) {
            throw new WorkspaceError('INVALID_INPUT', {
              'preview.days': 'Choose how long the link should work.',
            });
          }
          const name = v.prospectName && v.prospectName.length > 0 ? v.prospectName : undefined;
          if (name !== undefined && !isValidProspectName(name)) {
            throw new WorkspaceError('INVALID_INPUT', {
              'preview.prospectName': `Use 1 to ${PREVIEW_TOKEN.maxNameLength} characters of plain text, without < or >.`,
            });
          }

          const found = await tx.$queryRaw<{ name: string; slug: string }[]>`
            SELECT name, slug FROM app.get_catalog_template(${templateId}::uuid)`;
          const template = found[0];
          if (!template) throw new WorkspaceError('NOT_FOUND');

          const since = new Date(now().getTime() - 86_400_000);
          const recent = await tx.auditLog.count({
            where: { action: ACTION, actorId: scope.actorUserId, createdAt: { gt: since } },
          });
          if (recent >= perDay) throw new WorkspaceError('RATE_LIMITED');

          const issued = now();
          const token = mintPreviewToken(preview.secret, {
            templateId,
            ...(name ? { prospectName: name } : {}),
            lifetimeSeconds: days * 86_400,
            now: issued,
          });
          const local = preview.host.endsWith('localhost');
          const url = `${local ? 'http' : 'https'}://${preview.host}${local ? ':3001' : ''}/p/${token}`;
          return {
            result: {
              url,
              expiresAt: new Date(issued.getTime() + days * 86_400_000).toISOString(),
              templateName: template.name,
            },
            audit: {
              targetType: 'template',
              targetId: templateId,
              metadata: { slug: template.slug, days, personalised: name !== undefined },
            },
          };
        },
      );
    },
  };
}

export type TemplateService = ReturnType<typeof createTemplateService>;
