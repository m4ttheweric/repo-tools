/** Compact "time since" for a start timestamp, e.g. "3m", "1h2m", "5s". */
export function uptime(startedAt: number | undefined, now: number): string {
  if (startedAt == null) return "";
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h${mins % 60}m`;
}

/** Last path segment of a worktree dir for a compact label. */
export function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}
