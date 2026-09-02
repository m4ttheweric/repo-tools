/**
 * In-process double for the `pick` verb. Every wrapper/surface test that
 * exercises a picker flow should install one of these instead of spawning
 * the real rt-ui binary: it mirrors how prompts.test.ts swaps the prompt
 * spawn by pointing RT_UI_BIN at a fake, but does it in-process by swapping
 * pick.ts's own impl seam, so nothing under test needs to know the fake exists.
 */
import { __test__ as pickTest, type PickCallbacks, type PickHandle, type PickImpl } from "./pick.ts";
import type { PickEvent, PickRequest, PickResult, PickRow, PickUpdate } from "./protocol.ts";

export type PickFakeStep =
  | { kind: "event"; event: Omit<PickEvent, "t"> }
  | { kind: "modal-result"; value: string | null }
  | { kind: "result"; result: Omit<PickResult, "t"> };

export interface PickFakeCall {
  /** The fully stamped request runPick sent -- includes t/protocol. */
  request: PickRequest;
  updates: Array<Omit<PickUpdate, "t">>;
  modals: Array<{ message: string; rows: PickRow[] }>;
}

export interface PickFake {
  /** One entry per runPick() call made while this fake is installed. */
  calls: PickFakeCall[];
  /** Restores the real spawn-based impl. Safe to call more than once. */
  restore(): void;
}

/**
 * Installs the fake and returns a handle to inspect calls and restore the
 * real impl. `script` is played back in order against each runPick() call:
 * an "event" step waits for a prior event's onEvent to finish before firing
 * the next (mirroring the real wire's per-line serialization), a
 * "modal-result" step waits until the caller has an outstanding modal()
 * before resolving it (mirroring the real protocol, where the child can
 * only answer a modal after receiving one), and "result" settles
 * PickHandle.result after any already-queued events have been delivered.
 */
export function installFakePick(script: PickFakeStep[]): PickFake {
  const calls: PickFakeCall[] = [];

  const fakeImpl: PickImpl = (req: PickRequest, cb: PickCallbacks) => {
    const call: PickFakeCall = { request: req, updates: [], modals: [] };
    calls.push(call);

    let resolveResult!: (r: PickResult) => void;
    const result = new Promise<PickResult>((res) => {
      resolveResult = res;
    });

    const pendingModals: Array<(v: string | null) => void> = [];
    let wakeModal: (() => void) | null = null;

    (async () => {
      let eventChain: Promise<void> = Promise.resolve();
      for (const step of script) {
        switch (step.kind) {
          case "event": {
            const evt: PickEvent = { t: "event", ...step.event };
            eventChain = eventChain.then(() => cb.onEvent?.(evt));
            await eventChain;
            break;
          }
          case "modal-result": {
            while (pendingModals.length === 0) {
              await new Promise<void>((resolve) => {
                wakeModal = resolve;
              });
            }
            wakeModal = null;
            const resolveModal = pendingModals.shift()!;
            resolveModal(step.value);
            break;
          }
          case "result": {
            await eventChain;
            resolveResult({ t: "result", ...step.result });
            break;
          }
        }
      }
    })();

    return {
      update(patch) {
        call.updates.push(patch);
      },
      modal(message, rows) {
        call.modals.push({ message, rows });
        return new Promise<string | null>((resolve) => {
          pendingModals.push(resolve);
          wakeModal?.();
        });
      },
      result,
    } satisfies PickHandle;
  };

  pickTest.setImpl(fakeImpl);
  let restored = false;
  return {
    calls,
    restore() {
      if (restored) return;
      restored = true;
      pickTest.setImpl(undefined);
    },
  };
}
