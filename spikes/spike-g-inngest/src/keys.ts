/**
 * Two targets, same suite:
 * - local (default): `inngest start` from docker-compose.yml with the throwaway keys below, which mean
 *   nothing outside this spike;
 * - live (SPIKE_G_LIVE=1): Inngest Cloud. Keys come from the environment and are never written to disk
 *   by the spike; SPIKE_G_SERVE_ORIGIN is a public tunnel URL that forwards to SERVE_PORT.
 */
const live = process.env.SPIKE_G_LIVE === '1';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required when SPIKE_G_LIVE=1`);
  return v;
}

export const LIVE = live;
/** undefined = the SDK default (Inngest Cloud). */
export const INNGEST_BASE_URL = live ? undefined : 'http://localhost:8288';
export const EVENT_KEY = live ? required('INNGEST_EVENT_KEY') : 'spike-g-local-event-key';
/** SDK form; the SDK strips the `signkey-<env>-` prefix before signing. */
export const SIGNING_KEY = live
  ? required('INNGEST_SIGNING_KEY')
  : 'signkey-prod-000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

export const SERVE_PORT = 3939;
export const SERVE_PATH = '/api/inngest';
/** How the Inngest server reaches the serve handler running on this machine. */
export const SERVE_ORIGIN_FOR_SERVER = live
  ? required('SPIKE_G_SERVE_ORIGIN')
  : `http://host.docker.internal:${SERVE_PORT}`;
