/**
 * Shared code/message derivation for a thrown error reaching a request
 * boundary (fetch()'s own routing/dispatch bugs in api-server.ts and
 * socket-server.ts, and createHandleCommand's throw-to-envelope path in
 * daemon.ts). R1: previously duplicated three times, each copy able to
 * drift from the other two.
 */
export function deriveFailure(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "handler-threw";
  return { code, message };
}
