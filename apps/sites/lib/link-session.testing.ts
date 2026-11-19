/**
 * Test helper (P3 S9b): requests a link path the way a browser does. A token path answers 303 with the link cookie;
 * the helper then requests the clean path with that cookie, as the browser would, and returns the final response.
 * `exchanged` holds the first answer when there was one.
 */
export async function followLink(
  send: (request: Request) => Promise<Response>,
  url: string,
  init: { method?: string; headers: Record<string, string> },
): Promise<Response & { exchanged?: Response }> {
  const first = await send(new Request(url, init));
  const location = first.headers.get('location');
  const cookie = first.headers.get('set-cookie');
  if (first.status !== 303 || !location || !cookie || !/^\/(review|preview)\//.test(location)) return first;
  const next = new URL(location, url).toString();
  const final = (await send(
    new Request(next, { ...init, headers: { ...init.headers, cookie: cookie.split(';')[0] as string } }),
  )) as Response & { exchanged?: Response };
  final.exchanged = first;
  return final;
}
