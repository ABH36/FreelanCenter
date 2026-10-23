/**
 * Inngest serve endpoint (ADR-007). Requests are signed by Inngest and verified by the SDK in cloud mode
 * (`isDev` comes from validated config, Spike G G-1). 404 with the inline transport (local development), where
 * no executor calls in. Edge rate limiting of this route (G-6) is a Vercel firewall rule, tracked in the S5 report.
 */
import { workspaceRuntime } from '@/lib/workspaces';

export const dynamic = 'force-dynamic';

async function handle(method: 'GET' | 'POST' | 'PUT', request: Request): Promise<Response> {
  const route = workspaceRuntime().jobs.route;
  if (!route) return new Response(null, { status: 404 });
  return route[method](request);
}

export const GET = (request: Request) => handle('GET', request);
export const POST = (request: Request) => handle('POST', request);
export const PUT = (request: Request) => handle('PUT', request);
