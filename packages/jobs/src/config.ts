/**
 * Job runtime configuration (ADR-007 mandatory configuration, Spike G finding G-1). Read once and validated up
 * front: the Inngest SDK skips request-signature checks whenever it runs in dev mode, and the `INNGEST_DEV`
 * variable switches dev mode on unless `isDev` is set explicitly. So `isDev` always comes from here, and a
 * preview or production deployment refuses dev mode, the inline transport and a missing key.
 */

/**
 * `inngest`: events go to Inngest (Cloud, or the local dev server / self-hosted executor via INNGEST_BASE_URL).
 * `inline`: local development and tests only; the same handler runs in-process after the response.
 */
export type JobsTransport = 'inngest' | 'inline';

export interface JobsConfig {
  transport: JobsTransport;
  /** Passed to the SDK verbatim; true only for a local Inngest dev server. */
  isDev: boolean;
  eventKey?: string;
  signingKey?: string;
  /** Self-hosted executor or dev server; undefined = Inngest Cloud. */
  baseUrl?: string;
}

export class JobsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobsConfigError';
  }
}

export function loadJobsConfig(env: Record<string, string | undefined> = process.env): JobsConfig {
  const deployed = env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview';
  const value = (key: string) => env[key]?.trim() || undefined;

  const transport = (value('JOBS_TRANSPORT') ?? (deployed ? 'inngest' : 'inline')) as string;
  if (transport !== 'inngest' && transport !== 'inline') {
    throw new JobsConfigError('JOBS_TRANSPORT must be inngest or inline');
  }
  const devFlag = value('INNGEST_DEV');
  if (deployed) {
    if (transport !== 'inngest')
      throw new JobsConfigError('JOBS_TRANSPORT=inline is not allowed when deployed');
    if (devFlag) throw new JobsConfigError('INNGEST_DEV must not be set when deployed (G-1)');
  }
  if (transport === 'inline') return { transport, isDev: false };

  const isDev = !deployed && devFlag !== undefined && devFlag !== '0';
  const signingKey = value('INNGEST_SIGNING_KEY');
  const eventKey = value('INNGEST_EVENT_KEY');
  if (!isDev && !signingKey) throw new JobsConfigError('INNGEST_SIGNING_KEY is not set (G-1)');
  if (!isDev && !eventKey) throw new JobsConfigError('INNGEST_EVENT_KEY is not set');
  const baseUrl = value('INNGEST_BASE_URL');
  if (deployed && baseUrl) throw new JobsConfigError('INNGEST_BASE_URL must not be set when deployed');
  return { transport, isDev, signingKey, eventKey, baseUrl };
}
