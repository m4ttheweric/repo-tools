import { describe, expect, test } from "bun:test";
import type { KeymapContext } from "../types.ts";
import { createProcessKeymap } from "../process.ts";

function makeContext(): KeymapContext {
  return {
    openTempPane: () => "%5",
    displayPane: () => "%1",
    mrPane: {
      isEnabled: () => false,
      setEnabled: () => {},
      show: () => {},
      hide: () => {},
      update: () => {},
    },
    stopApp: () => {},
    setMode: () => {},
    getCurrentState: () => null,
    doDispatch: () => {},
    showToast: () => {},
    openPopup: () => {},
    switchDisplay: () => {},
    createBgPane: () => "%2",
    initDisplayPane: () => {},
    saveCurrent: () => {},
    addResolvedEntry: async () => {},
    activeEntryIdx: () => 0,
    focusedBranch: () => "",
    safeUpdate: () => {},
    rtShell: "rt",
    rtInvoke: ["rt"],
    initiator: "test",
  };
}

describe("process runner keymap", () => {
  test("does not duplicate the top-level start shortcut", () => {
    const keymap = createProcessKeymap(makeContext(), {
      buildEditorCmd: (filePath) => ({ editorCmd: filePath, hint: "" }),
    });

    expect("s" in keymap).toBe(false);
    expect(typeof keymap.enter).toBe("function");
  });
});
