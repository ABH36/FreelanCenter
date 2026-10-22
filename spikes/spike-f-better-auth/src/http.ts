/**
 * Minimal browser stand-in: drives Better Auth through its real Request -> Response handler
 * (the same handler `toNextJsHandler` mounts in a Next 16 route) and keeps a cookie jar.
 */
import type { Auth } from './auth';

export interface Res {
  status: number;
  json: unknown;
  body: string;
  headers: Headers;
  setCookies: string[];
}

export class Browser {
  readonly cookies = new Map<string, string>();

  constructor(
    private readonly auth: Auth,
    private readonly ip: string,
    private readonly origin = 'http://localhost:3000',
  ) {}

  async req(
    path: string,
    opts: { method?: 'GET' | 'POST'; body?: unknown; query?: Record<string, string> } = {},
  ): Promise<Res> {
    const url = new URL(`/api/auth${path}`, this.origin);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers = new Headers({
      origin: this.origin,
      'x-forwarded-for': this.ip,
      'user-agent': 'spike-f-browser',
    });
    if (opts.body !== undefined) headers.set('content-type', 'application/json');
    if (this.cookies.size) {
      headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    const res = await this.auth.handler(
      new Request(url, {
        method: opts.method ?? 'POST',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        redirect: 'manual',
      }),
    );
    const setCookies = res.headers.getSetCookie();
    for (const sc of setCookies) {
      const [pair = ''] = sc.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!value || /max-age=0/i.test(sc)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const body = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    return { status: res.status, json, body, headers: res.headers, setCookies };
  }

  sessionCookieName(): string | undefined {
    return [...this.cookies.keys()].find((k) => k.endsWith('session_token'));
  }
}
