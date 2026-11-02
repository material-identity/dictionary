/**
 * Canonical interface on material-identity.eu (plan §4 M4 item 3; handover §8; redesigned
 * per issue #57 — no concept resource, so no /concept/<uuid> route).
 * Stateless mapping: URI + Accept → origin file + headers. No entry knowledge —
 * reproducible on any reverse proxy (D3). Deploys are CI-only (deploy-worker.yml).
 * Routes: /def/<uuid>, /spec/<act>[/<version>[/<file>]], /catalog, /ns (#135), /.well-known/,
 * /examples/; everything else passes through.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Content specifications (#135; schema design content-spec-jsonld.md §2.1). Strict shapes: an act
// key and a semantic contract version. Anything else under /spec/ falls through untouched.
const ACT = '[a-z][a-z0-9-]*';
const VERSION = 'v\\d+\\.\\d+\\.\\d+';
const SPEC = new RegExp(`^/spec/(${ACT})/(${VERSION})$`);
const SPEC_FILE = new RegExp(`^/spec/(${ACT})/(${VERSION})/(context\\.jsonld|compressed\\.schema\\.json|full\\.schema\\.json)$`);
const SERIES = new RegExp(`^/spec/(${ACT})$`);

const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=300';
const HTML = 'text/html; charset=utf-8';
const JSON_LD = 'application/ld+json';
const TURTLE = 'text/turtle; charset=utf-8';

export interface RouteDecision {
  originPath: string;
  headers: Record<string, string>;
}

const wantsHtml = (accept: string | null): boolean => (accept ?? '').includes('text/html');

/**
 * A negotiated JSON-LD resource stored as `<dir>/index.jsonld` + `<dir>/index.html` at the origin.
 * Vary: one URI, two representations, so no cache may hand a browser's HTML to a JSON-LD client.
 */
function negotiated(dir: string, accept: string | null, cache: string): RouteDecision {
  const html = wantsHtml(accept);
  return {
    originPath: `${dir}/index.${html ? 'html' : 'jsonld'}`,
    headers: { 'content-type': html ? HTML : JSON_LD, 'cache-control': cache, vary: 'Accept' },
  };
}

/** Pure mapping, unit-tested. JSON is the default; HTML only when Accept names text/html (handover §8). */
export function decide(pathname: string, accept: string | null): RouteDecision {
  // A published content specification never changes (design §2.3): a new contract version is a
  // new IRI, so the spec and its sub-resources are as immutable as an entry.
  const spec = SPEC.exec(pathname);
  if (spec) {
    const decision = negotiated(pathname, accept, IMMUTABLE);
    const citeAs = `<https://material-identity.eu${pathname}>; rel="cite-as"`;
    decision.headers.link = wantsHtml(accept) ? `<${pathname}>; rel="canonical", ${citeAs}` : citeAs;
    return decision;
  }
  const specFile = SPEC_FILE.exec(pathname);
  if (specFile) {
    const type = specFile[3] === 'context.jsonld' ? JSON_LD : 'application/schema+json';
    return { originPath: pathname, headers: { 'content-type': type, 'cache-control': IMMUTABLE } };
  }
  // Derived listings: a new version or release joins them, so they get the short cache of /feed.xml.
  if (SERIES.test(pathname) || pathname === '/catalog') return negotiated(pathname, accept, SHORT);
  // The mi: vocabulary (design §3.3, §9 Q6). Turtle on request, since that is what RDF tools ask for.
  if (pathname === '/ns') {
    if (!wantsHtml(accept) && (accept ?? '').includes('text/turtle')) {
      return { originPath: '/ns/index.ttl', headers: { 'content-type': TURTLE, 'cache-control': SHORT, vary: 'Accept' } };
    }
    return negotiated('/ns', accept, SHORT);
  }

  const m = /^\/def\/([^/]+)$/.exec(pathname);
  if (m && UUID.test(m[1])) {
    const uuid = m[1];
    const html = wantsHtml(accept);
    const headers: Record<string, string> = {
      'content-type': html ? HTML : 'application/json; charset=utf-8',
      'cache-control': IMMUTABLE, // entries never change (R6)
    };
    // RFC 8574: cite the canonical id whatever URL was fetched; HTML also names itself canonical.
    const citeAs = `<https://material-identity.eu/def/${uuid}>; rel="cite-as"`;
    headers.link = html ? `</def/${uuid}>; rel="canonical", ${citeAs}` : citeAs;
    return { originPath: `/def/${uuid}.${html ? 'html' : 'json'}`, headers };
  }
  // RFC 8615 well-known URIs (#107, #109). Cacheable but never immutable like an entry: a key can
  // be rotated or revoked and security.txt expires, so a day is the ceiling. Pages would serve
  // .asc as a generic byte stream and .txt without a charset, hence the explicit types.
  //
  // The origin stores these under `well-known/`, undotted (#110): actions/upload-pages-artifact
  // tars with `--exclude=.[^/]*` and silently drops any dot-directory, which 404'd the live URL
  // while every local test passed. Rewriting here keeps the canonical, RFC-mandated URL intact —
  // mapping a URI onto an origin file is this Worker's whole job.
  if (pathname.startsWith('/.well-known/')) {
    const headers: Record<string, string> = { 'cache-control': 'public, max-age=86400' };
    if (pathname.endsWith('.asc')) headers['content-type'] = 'application/pgp-keys';
    if (pathname.endsWith('.txt')) headers['content-type'] = 'text/plain; charset=utf-8'; // RFC 9116 §3
    return { originPath: `/well-known/${pathname.slice('/.well-known/'.length)}`, headers };
  }

  // Reference examples (#130): not entries, so never immutable — a newer copy replaces a file in
  // place. Typed explicitly rather than trusting the origin's guess, as for .well-known.
  if (pathname.startsWith('/examples/') && pathname.endsWith('.json')) {
    return { originPath: pathname, headers: { 'cache-control': 'public, max-age=300', 'content-type': 'application/json; charset=utf-8' } };
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
