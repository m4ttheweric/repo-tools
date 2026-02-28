import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join, dirname } from 'path';
import { Eta } from 'eta';
import {
  type Worktree,
  displayName,
  isHtmlResponse,
  pickUpstream,
  BADGE_COLORS,
} from './lib';

const eta = new Eta({
  views: join(dirname(import.meta.path), 'templates'),
  cache: true,
});

const worktrees: Worktree[] = [
  { path: '/-/alpha', upstream: 0 },
  { path: '/-/beta', upstream: 0 },
];

let upstreamA: ReturnType<typeof Bun.serve>;
let upstreamB: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.serve>;
let proxyUrl: string;

function worktreeVars(w: Worktree) {
  return {
    path: w.path,
    name: displayName(w),
    upstream: w.upstream,
    branch: '',
    shortDir: '',
  };
}

function buildBadgeHtml(active: Worktree): string {
  const activeIdx = worktrees.indexOf(active);
  const color = BADGE_COLORS[activeIdx % BADGE_COLORS.length];
  const items = worktrees
    .map(w =>
      eta.render('./badge-item', { active: w === active, ...worktreeVars(w) }),
    )
    .join('');
  return eta.render('./badge', { color, ...worktreeVars(active), items });
}

beforeAll(() => {
  upstreamA = Bun.serve({
    port: 0,
    fetch() {
      return new Response('<html><body><h1>upstream-alpha</h1></body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  });

  upstreamB = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/data') {
        return Response.json({ from: 'beta' });
      }
      return new Response('<html><body><h1>upstream-beta</h1></body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  });

  worktrees[0].upstream = upstreamA.port!;
  worktrees[1].upstream = upstreamB.port!;

  const defaultWorktree = worktrees[0];
  const worktreeByPath = new Map(worktrees.map(w => [w.path, w]));

  proxy = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      const matched = worktreeByPath.get(url.pathname);
      if (matched) {
        const next = url.searchParams.get('next') ?? '/';
        return new Response(
          `<!DOCTYPE html><html><head>` +
            `<script>document.cookie="wt=${matched.path};path=/;samesite=lax";` +
            `location.replace("${next}");</script>` +
            `</head></html>`,
          {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            },
          },
        );
      }

      if (url.pathname === '/status') {
        return new Response('<html><body>status</body></html>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      const wt = pickUpstream(req, worktreeByPath, defaultWorktree);

      const target = `http://localhost:${wt.upstream}${url.pathname}${url.search}`;
      try {
        const headers = new Headers(req.headers);
        headers.set('host', `localhost:${wt.upstream}`);
        const proxyRes = await fetch(target, {
          method: req.method,
          headers,
          body: req.body,
          redirect: 'manual',
        });

        if (!isHtmlResponse(proxyRes.headers)) return proxyRes;

        const text = await proxyRes.text();
        const badge = buildBadgeHtml(wt);
        const injected = text.includes('</body>')
          ? text.replace('</body>', badge + '\n</body>')
          : text + badge;

        const respHeaders = new Headers(proxyRes.headers);
        respHeaders.delete('content-length');
        respHeaders.delete('content-encoding');
        return new Response(injected, {
          status: proxyRes.status,
          headers: respHeaders,
        });
      } catch {
        return new Response(`502`, { status: 502 });
      }
    },
  });

  proxyUrl = `http://localhost:${proxy.port}`;
});

afterAll(() => {
  proxy?.stop(true);
  upstreamA?.stop(true);
  upstreamB?.stop(true);
});

describe('switch endpoints', () => {
  test('returns HTML that sets cookie and navigates to /', async () => {
    const res = await fetch(`${proxyUrl}/-/beta`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).toContain('wt=/-/beta');
    expect(text).toContain('location.replace("/")');
  });

  test('uses ?next= value in navigation', async () => {
    const res = await fetch(`${proxyUrl}/-/alpha?next=/dashboard`);
    const text = await res.text();
    expect(text).toContain('location.replace("/dashboard")');
  });
});

describe('default routing (no cookie)', () => {
  test('routes to first worktree by default', async () => {
    const res = await fetch(proxyUrl);
    const text = await res.text();
    expect(text).toContain('upstream-alpha');
  });
});

describe('cookie-based routing', () => {
  test('routes to beta when wt cookie is set', async () => {
    const res = await fetch(proxyUrl, {
      headers: { cookie: '  wt=/-/beta' },
    });
    const text = await res.text();
    expect(text).toContain('upstream-beta');
  });

  test('falls back to default for invalid cookie value', async () => {
    const res = await fetch(proxyUrl, {
      headers: { cookie: 'wt=/-/nope' },
    });
    const text = await res.text();
    expect(text).toContain('upstream-alpha');
  });
});

describe('badge injection', () => {
  test('injects badge into HTML responses', async () => {
    const res = await fetch(proxyUrl);
    const text = await res.text();
    expect(text).toContain('id="__dp"');
    expect(text).toContain('</body>');
  });

  test('badge shows active worktree name', async () => {
    const res = await fetch(proxyUrl, {
      headers: { cookie: 'wt=/-/beta' },
    });
    const text = await res.text();
    expect(text).toContain('beta');
    expect(text).toContain('id="__dp-pill"');
  });

  test('does not inject badge into JSON responses', async () => {
    const res = await fetch(`${proxyUrl}/api/data`, {
      headers: { cookie: 'wt=/-/beta' },
    });
    const json = await res.json();
    expect(json).toEqual({ from: 'beta' });
  });

  test('content-length reflects injected body size', async () => {
    const res = await fetch(proxyUrl);
    const text = await res.text();
    const cl = res.headers.get('content-length');
    if (cl) {
      expect(parseInt(cl)).toBe(new TextEncoder().encode(text).length);
    }
  });
});

describe('status page', () => {
  test('returns HTML at /status', async () => {
    const res = await fetch(`${proxyUrl}/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

describe('502 handling', () => {
  test('returns 502 when upstream is unreachable', async () => {
    const deadWorktree: Worktree = {
      path: '/-/dead',
      upstream: 1,
    };
    const byPath = new Map([['/-/dead', deadWorktree]]);

    const deadProxy = Bun.serve({
      port: 0,
      async fetch(req) {
        const wt = pickUpstream(req, byPath, deadWorktree);
        try {
          await fetch(`http://localhost:${wt.upstream}/`);
          return new Response('ok');
        } catch {
          return new Response('502', { status: 502 });
        }
      },
    });

    try {
      const res = await fetch(`http://localhost:${deadProxy.port}/`, {
        headers: { cookie: 'wt=/-/dead' },
      });
      expect(res.status).toBe(502);
    } finally {
      deadProxy.stop(true);
    }
  });
});
