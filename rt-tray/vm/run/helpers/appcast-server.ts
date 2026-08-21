// Static file server for the in-guest Sparkle appcast. Loopback only, so the
// guest never crosses macOS 15's Local Network Privacy boundary to the host.
import { existsSync, statSync } from "fs";
import { join, normalize, resolve, extname } from "path";

const [dir, portArg] = process.argv.slice(2);
if (!dir || !portArg) {
  console.error("usage: appcast-server <dir> <port>");
  process.exit(2);
}
const root = resolve(dir);
const port = Number(portArg);
const types: Record<string, string> = {
  ".xml": "application/rss+xml; charset=utf-8",
  ".zip": "application/zip",
  ".dmg": "application/x-apple-diskimage",
  ".delta": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const path = normalize(decodeURIComponent(new URL(req.url).pathname));
    const file = join(root, path);
    const ok = file.startsWith(root + "/") && existsSync(file) && statSync(file).isFile();
    console.error(`${new Date().toISOString()} ${req.method} ${path} → ${ok ? 200 : 404}`);
    if (!ok) return new Response("not found", { status: 404 });
    const size = statSync(file).size;
    return new Response(Bun.file(file), {
      headers: {
        "content-type": types[extname(file)] ?? "application/octet-stream",
        "content-length": String(size),
        "cache-control": "no-store",
      },
    });
  },
});
console.error(`appcast-server: serving ${root} on http://127.0.0.1:${server.port}/`);
process.on("SIGTERM", () => { server.stop(); process.exit(0); });
process.on("SIGINT", () => { server.stop(); process.exit(0); });
