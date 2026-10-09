/**
 * Serves the built client out of dist/.
 *
 * Cache-Control is decided per file on purpose: Vite fingerprints everything under
 * /assets/, so those are safe to pin for a year, while the service worker, the web
 * manifest and the index.html shell must revalidate on every load - a cached sw.js
 * or shell pins the installed PWA to a build the user can no longer get rid of.
 */

import { existsSync, realpathSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { readPointer } from '../scripts/release/activate.ts';
import { contained, validateArtifact, hash, boundedRead } from '../scripts/release/manifest.ts';

// A URL's pathname is not a file path: on Windows it is `/C:/...`, and spaces come percent-encoded.
export function isolatedStaticRoot(staging: string | undefined, owned: string | undefined): string {
  if (!staging) return join(import.meta.dir, "..", "dist");
  if (!owned || !existsSync(staging) || !existsSync(owned)) throw new Error("Staging static root requires an owned directory");
  const candidate = realpathSync(resolve(staging)), root = realpathSync(resolve(owned));
  if (!candidate.startsWith(root + "/")) throw new Error("Staging static root escapes isolation");
  return candidate;
}
const DIST_DIR = isolatedStaticRoot(process.env.HERDR_STAGING_DIST, process.env.TERMWEAVE_TEST_ROOT);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Files whose URL never changes but whose contents decide what the app becomes. */
const REVALIDATED_PATHS = new Set(["/sw.js", "/manifest.webmanifest"]);

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const SHORT_CACHE = "public, max-age=86400";
const REVALIDATE = "no-cache";
// The authenticated UI must not be embedded via another hostname or a redirect.
const FRAME_GUARDS = { "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY" };

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return MIME[path.slice(dot)] ?? "application/octet-stream";
}

function cacheControlFor(pathname: string): string {
  if (REVALIDATED_PATHS.has(pathname)) return REVALIDATE;
  if (pathname.startsWith("/assets/")) return IMMUTABLE_CACHE;
  return SHORT_CACHE;
}

const validatedReleasePointers = new Map<string, string>();

export async function serveStatic(pathname: string, deploymentRoot = process.env.TERMWEAVE_RELEASE_ROOT): Promise<Response> {
  let dist = DIST_DIR;
  let activeManifest: ReturnType<typeof validateArtifact> | null = null;
  if (deploymentRoot) {
    const pointer = readPointer(deploymentRoot);
    if (!pointer) throw new Error('Release pointer missing');
    const collection = join(deploymentRoot, 'releases');
    if (lstatSync(collection).isSymbolicLink()) throw new Error('Release collection symlink forbidden');
    contained(deploymentRoot, collection);
    const release = contained(collection, join(collection, pointer.active));
    const rootStat = lstatSync(deploymentRoot), releaseStat = lstatSync(release), manifestStat = lstatSync(join(release, 'manifest.json'));
    const pointerIdentity = `${rootStat.dev}:${rootStat.ino}:${pointer.generation}:${pointer.active}:${releaseStat.ino}:${manifestStat.ino}:${manifestStat.mtimeMs}:${manifestStat.size}`;
    const rootIdentity = realpathSync(deploymentRoot);
    if (validatedReleasePointers.get(rootIdentity) !== pointerIdentity) {
      validateArtifact(release);
      validatedReleasePointers.set(rootIdentity, pointerIdentity);
    }
    activeManifest = JSON.parse(boundedRead(join(release, 'manifest.json')).toString('utf8'));
    dist = join(release, 'dist');
  }
  if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.split('/').includes('..') || /%2e|%2f|%5c/i.test(pathname)) return new Response('Not found', { status: 404, headers: FRAME_GUARDS });
  const indexPath = join(dist, "index.html");
  if (!existsSync(indexPath) && deploymentRoot) return new Response('Release shell missing', { status: 503, headers: FRAME_GUARDS });
  if (!existsSync(indexPath)) {
    return new Response(
      "herdr-web-ui server is running, but the browser client has not been built yet.\nRun: bun run build\n",
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  const relative = pathname.slice(1);
  let candidate = join(dist, relative);
  if (!existsSync(candidate) && deploymentRoot && pathname.startsWith('/assets/')) {
    const retained = join(deploymentRoot, 'retained-assets');
    if (existsSync(retained)) { if (lstatSync(retained).isSymbolicLink()) throw new Error('Retained asset root symlink forbidden'); contained(deploymentRoot, retained); }
    candidate = join(retained, relative);
  }
  if (relative && existsSync(candidate)) {
    const base = candidate.startsWith(join(dist, 'assets')) || candidate.startsWith(dist) ? dist : join(deploymentRoot!, 'retained-assets');
    try { contained(base, candidate); } catch { return new Response('Not found', { status: 404, headers: FRAME_GUARDS }); }
    if (deploymentRoot) {
      const digest = candidate.startsWith(dist + '/') ? activeManifest?.assets[relative] : JSON.parse(boundedRead(contained(deploymentRoot, join(deploymentRoot, 'retained-digests.json'))).toString('utf8'))[relative];
      const stat = lstatSync(candidate); if (!stat.isFile() || stat.size > 16_777_216) throw new Error('Invalid bounded release asset');
      const bytes = boundedRead(candidate, 16_777_216);
      if (!digest || hash(bytes) !== digest) throw new Error('Immutable asset changed after validation');
      return new Response(new Uint8Array(bytes), { headers: { ...FRAME_GUARDS, 'content-type': contentTypeFor(candidate), 'cache-control': cacheControlFor(pathname) } });
    }
    const file = Bun.file(candidate);
    if ((await file.exists()) && !(await file.stat()).isDirectory()) {
      return new Response(file, {
        headers: { ...FRAME_GUARDS, "content-type": contentTypeFor(candidate), "cache-control": cacheControlFor(pathname) },
      });
    }
  }
  if (/\.(?:js|css|json|woff2?|svg|png|ico|webmanifest)$/i.test(pathname)) return new Response('Not found', { status: 404, headers: FRAME_GUARDS });
  if (deploymentRoot) {
    contained(dist, indexPath);
    const stat = lstatSync(indexPath); if (!stat.isFile() || stat.size > 16_777_216) throw new Error('Invalid release shell');
    const bytes = boundedRead(indexPath, 16_777_216);
    if (hash(bytes) !== activeManifest?.assets['index.html']) throw new Error('Immutable shell changed after validation');
    return new Response(new Uint8Array(bytes), { headers: { ...FRAME_GUARDS, 'content-type': 'text/html; charset=utf-8', 'cache-control': REVALIDATE } });
  }
  return new Response(Bun.file(indexPath), {
    headers: { ...FRAME_GUARDS, "content-type": "text/html; charset=utf-8", "cache-control": REVALIDATE },
  });
}
