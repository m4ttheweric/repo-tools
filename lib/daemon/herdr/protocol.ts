export interface HerdrRequest { id: string; method: string; params?: unknown }
export interface HerdrResponse { id: string; result?: any; error?: { code: string; message: string } }

export function encodeRequest(req: HerdrRequest): string {
  const obj: Record<string, unknown> = { id: req.id, method: req.method };
  if (req.params !== undefined) obj.params = req.params;
  return JSON.stringify(obj) + "\n";
}

export function parseLine(line: string): HerdrResponse | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (!obj || typeof obj !== "object" || typeof obj.id !== "string") return null;
    return obj as HerdrResponse;
  } catch {
    return null;
  }
}
