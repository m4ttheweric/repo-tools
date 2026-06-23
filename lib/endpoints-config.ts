/**
 * Per-repo canonical endpoints. Declared endpoints live in
 * ~/.rt/repos/<repo>/endpoints.json; runtime mappings (which process a forward
 * endpoint targets; which bounce ports are enabled) live in endpoint-state.json.
 * Both are local -- repo stealth, never in the repo.
 */
import { join } from "path";
import { readJson, writeJson } from "./json-store.ts";

export interface CanonicalEndpoint {
  port: number;
  name: string;
  mode: "forward" | "bounce";
  returnParam?: string;
}

export interface EndpointState {
  /** forward endpoint port (as string key) -> processId it targets */
  forward: Record<string, string>;
  /** bounce endpoint ports that are currently enabled */
  bounceEnabled: number[];
}

export function loadEndpoints(dataDir: string): CanonicalEndpoint[] {
  const raw = readJson<{ endpoints?: unknown }>(join(dataDir, "endpoints.json"), {});
  const list = Array.isArray(raw.endpoints) ? raw.endpoints : [];
  return list.reduce<CanonicalEndpoint[]>((acc, e: unknown) => {
    if (!e || typeof e !== "object") return acc;
    const obj = e as Record<string, unknown>;
    const port = obj.port;
    const name = obj.name;
    const mode = obj.mode;
    if (!Number.isInteger(port) || typeof name !== "string" || (mode !== "forward" && mode !== "bounce")) {
      return acc;
    }
    const endpoint: CanonicalEndpoint = {
      port: port as number,
      name: name as string,
      mode: mode as "forward" | "bounce",
    };
    if (mode === "bounce") {
      endpoint.returnParam = typeof obj.returnParam === "string" ? obj.returnParam : "rt_return";
    }
    return [...acc, endpoint];
  }, []);
}

export function loadEndpointState(dataDir: string): EndpointState {
  const s = readJson<Partial<EndpointState>>(join(dataDir, "endpoint-state.json"), {});
  return {
    forward: s.forward && typeof s.forward === "object" ? s.forward : {},
    bounceEnabled: Array.isArray(s.bounceEnabled) ? s.bounceEnabled : [],
  };
}

export function saveEndpointState(dataDir: string, state: EndpointState): void {
  writeJson(join(dataDir, "endpoint-state.json"), state);
}
