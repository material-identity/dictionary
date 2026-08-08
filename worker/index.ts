/**
 * Canonical interface on material-identity.eu (plan §4 M4 item 3; handover §8; redesigned
 * per issue #57 — no concept resource, so no /concept/<uuid> route).
 * Stateless mapping: URI + Accept → origin file + headers. No entry knowledge —
 * reproducible on any reverse proxy (D3). Deploys are CI-only (deploy-worker.yml).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface RouteDecision {
  originPath: string;
  headers: Record<string, string>;
}

/** Pure mapping, unit-tested. JSON is the default; HTML only when Accept names text/html (handover §8). */
export function decide(pathname: string, accept: string | null): RouteDecision {
  const m = /^\/def\/([^/]+)$/.exec(pathname);
  if (m && UUID.test(m[1])) {
    const uuid = m[1];
    const wantsHtml = (accept ?? '').includes('text/html');
    const headers: Record<string, string> = {
      'content-type': wantsHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable', // entries never change (R6)
    };
    if (wantsHtml) headers.link = `</def/${uuid}>; rel="canonical"`;
    return { originPath: `/def/${uuid}.${wantsHtml ? 'html' : 'json'}`, headers };
  }
  // index, pagination, styles, raw origin files: pass through with a short cache
  return { originPath: pathname === '/' ? '/index.html' : pathname, headers: { 'cache-control': 'public, max-age=300' } };
}

export default {
  async fetch(request: Request, env: { ORIGIN: string }): Promise<Response> {
    const { originPath, headers } = decide(new URL(request.url).pathname, request.headers.get('accept'));
    const origin = await fetch(`${env.ORIGIN}${originPath}`);
    if (!origin.ok) return new Response('Not found\n', { status: 404, headers: { 'cache-control': 'public, max-age=60' } });
    const out = new Headers(origin.headers);
    for (const [k, v] of Object.entries(headers)) out.set(k, v);
    return new Response(origin.body, { status: 200, headers: out });
  },
};
