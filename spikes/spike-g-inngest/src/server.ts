import http from 'node:http';
import { serve } from 'inngest/next';
import { SERVE_ORIGIN_FOR_SERVER, SERVE_PATH } from './keys';
import type { Client } from './jobs';

export interface RecordedRequest {
  method: string;
  url: string;
  signature: string | null;
  body: string;
  status: number;
  responseSignature: string | null;
  responseBody: string;
}

type Handler = (req: Request) => Promise<Response>;

/**
 * The `inngest/next` handler is what `app/api/inngest/route.ts` exports in Next 16 (`GET`, `POST`,
 * `PUT` taking a Web Request). Here a plain node server converts each request to a Web Request and
 * calls it, recording headers and raw bodies so signatures can be checked independently.
 */
export function createRouteHandler(client: Client, functions: Parameters<typeof serve>[0]['functions']) {
  const h = serve({ client, functions, servePath: SERVE_PATH, serveOrigin: SERVE_ORIGIN_FOR_SERVER });
  return { GET: h.GET as Handler, POST: h.POST as Handler, PUT: h.PUT as Handler };
}

export async function startServeHandler(route: ReturnType<typeof createRouteHandler>, port: number) {
  const recorded: RecordedRequest[] = [];

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const method = req.method ?? 'GET';
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);

    let response: Response;
    if (!req.url?.startsWith(SERVE_PATH) || !(method in route)) {
      response = new Response(null, { status: 404 });
    } else {
      const request = new Request(`http://localhost:${port}${req.url}`, {
        method,
        headers,
        body: method === 'GET' ? undefined : body,
      });
      response = await route[method as keyof typeof route](request);
    }
    const responseBody = await response.text();
    recorded.push({
      method,
      url: req.url ?? '',
      signature: headers.get('x-inngest-signature'),
      body,
      status: response.status,
      responseSignature: response.headers.get('x-inngest-signature'),
      responseBody,
    });
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(responseBody);
  });

  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  return { recorded, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
