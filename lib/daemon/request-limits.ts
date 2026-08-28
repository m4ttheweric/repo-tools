/**
 * Shared cap on request body size for both daemon servers (api-server.ts's
 * :9401 HTTP/WS surface and socket-server.ts's unix-socket IPC channel).
 * Neither transport authenticates reads, so an unbounded body (Bun's
 * default is 128 MB) lets any same-user process or a cross-origin browser
 * request stall the daemon's single event loop parsing a giant payload.
 * Real payloads on both transports are kilobytes; 1 MiB costs nothing and
 * turns an oversized request into an immediate 413 instead.
 */
export const MAX_REQUEST_BODY_SIZE = 1024 * 1024;
