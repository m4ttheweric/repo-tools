import { envelope } from "./contract.ts";

export class UserActionableError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function userErrorPayload(err: UserActionableError, now = new Date()) {
  return envelope({ error: { code: err.code, message: err.message, ...err.extra } }, now);
}

/** Prints the contract's exit-2 payload (JSON) or a one-line human message, then exits 2. */
export function exitUserError(err: UserActionableError, json: boolean, verb: string, print: (s: string) => void = console.log): never {
  print(json ? JSON.stringify(userErrorPayload(err)) : `rt ${verb}: ${err.message}`);
  process.exit(2);
}
