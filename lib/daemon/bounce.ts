/**
 * Bounce relay logic (pure). Receives an OAuth-style callback on a fixed
 * whitelisted port and 302s the browser back to the app's real origin, which is
 * named by a query param (default `rt_return`). Only origins rt currently knows
 * about are allowed -- this is the open-redirector guard.
 */
export interface BounceResult { status: number; location?: string; body?: string }

export function resolveBounce(reqUrl: string, returnParam: string, allowedOrigins: Set<string>): BounceResult {
  let url: URL;
  try { url = new URL(reqUrl); } catch { return { status: 400, body: "bad request url" }; }

  const ret = url.searchParams.get(returnParam);
  if (!ret) return { status: 400, body: `missing ${returnParam}` };

  let origin: string;
  try { origin = new URL(ret).origin; } catch { return { status: 400, body: "bad return origin" }; }
  if (!allowedOrigins.has(origin)) return { status: 400, body: "return origin not allowed" };

  const params = new URLSearchParams(url.search);
  params.delete(returnParam);
  const qs = params.toString();
  return { status: 302, location: `${origin}${url.pathname}${qs ? `?${qs}` : ""}` };
}
