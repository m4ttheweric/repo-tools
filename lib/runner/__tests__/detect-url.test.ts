import { test, expect } from "bun:test";
import { detectUrl } from "../state.ts";

test("detects a Vite Local banner", () => {
  expect(detectUrl("  VITE ready\n  ➜  Local:   http://localhost:5173/\n")).toBe("http://localhost:5173/");
});
test("detects a bare 127.0.0.1 url with port", () => {
  expect(detectUrl("listening http://127.0.0.1:8080/api")).toBe("http://127.0.0.1:8080/api");
});
test("prefers localhost over a LAN network address", () => {
  const t = "Network: http://192.168.1.20:3000/\nLocal:   http://localhost:3000/";
  expect(detectUrl(t)).toBe("http://localhost:3000/");
});
test("rewrites 0.0.0.0 to localhost", () => {
  expect(detectUrl("started server on http://0.0.0.0:3000")).toBe("http://localhost:3000");
});
test("ignores a real documentation domain", () => {
  expect(detectUrl("for help see https://vitejs.dev/config/")).toBeNull();
});
test("ignores a loopback host with no port", () => {
  expect(detectUrl("open http://localhost/")).toBeNull();
});
test("returns null when there is no url", () => {
  expect(detectUrl("compiling...\nbuilt in 1.2s")).toBeNull();
});
test("strips a trailing comma left by surrounding prose", () => {
  expect(detectUrl("see http://localhost:3000/api, then retry")).toBe("http://localhost:3000/api");
});
test("strips a trailing period left by surrounding prose", () => {
  expect(detectUrl("server is up at http://localhost:3000/api.")).toBe("http://localhost:3000/api");
});
test("picks the last localhost url when an auxiliary url logs first", () => {
  const t =
    "info: [JobConfig] queue endpoint=http://localhost:9324\n...\nGraphQL http://localhost:10400/graphql\nHealth http://localhost:10400/health";
  // The last match in the text is the health line, not the graphql line;
  // the point of this test is 10400 over 9324, not which 10400 path wins.
  expect(detectUrl(t)).toBe("http://localhost:10400/health");
});
