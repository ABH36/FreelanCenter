/**
 * Better Auth endpoints under /api/auth (ADR-006). Same shape as `toNextJsHandler`, but the auth instance is
 * resolved per request so building the app needs no secrets.
 */
import { getCorrelationIdFromHeaders, runWithContext } from '@platform/logger';
import { getAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  const correlationId = getCorrelationIdFromHeaders(request.headers);
  return runWithContext({ correlationId, app: 'dashboard' }, async () => {
    const auth = await getAuth();
    const upstream = await auth.handler(request);
    // Copy: a Response built with Response.redirect() has immutable headers.
    const response = new Response(upstream.body, upstream);
    response.headers.set('x-correlation-id', correlationId);
    response.headers.set('cache-control', 'no-store');
    return response;
  });
}

export const GET = handle;
export const POST = handle;
