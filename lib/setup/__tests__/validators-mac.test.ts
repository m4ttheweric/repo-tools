import { describe, test, expect } from "bun:test";
import { macRows } from "../validators/mac.ts";
import { fakeProbes, ok, missing } from "./fakes.ts";
import type { ExecScript } from "./fakes.ts";

async function pickRow(rowsP: ReturnType<typeof macRows>, id: string) {
  const rows = await rowsP;
  const r = rows.find((row) => row.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

const RC = "/fake-home/.zshenv";
const MARKER = "# mattstack — PATH precedence";

describe("macRows — tool.macos", () => {
  const exec = (version: string): ExecScript => (argv) => (argv[0] === "sw_vers" ? ok(`${version}\n`) : ok());

  test("15.6 -> ready", async () => {
    const r = await pickRow(macRows(fakeProbes({ exec: exec("15.6") })), "tool.macos");
    expect(r.status).toBe("ready");
    expect(r.detail).toContain("15.6");
    expect(r.required).toBe(true);
    expect(r.action).toBeNull();
  });

  test("13.7 -> invalid, floor not met", async () => {
    const r = await pickRow(macRows(fakeProbes({ exec: exec("13.7") })), "tool.macos");
    expect(r.status).toBe("invalid");
  });

  test("sw_vers unreachable -> error, never invalid (couldn't determine, not a failed determination)", async () => {
    const execScript: ExecScript = (argv) => (argv[0] === "sw_vers" ? missing("sw_vers") : ok());
    const r = await pickRow(macRows(fakeProbes({ exec: execScript })), "tool.macos");
    expect(r.status).toBe("error");
  });
});

describe("macRows — tool.clt", () => {
  test("xcode-select -p and git --version both succeed -> ready", async () => {
    const execScript: ExecScript = (argv) => {
      if (argv[0] === "sw_vers") return ok("15.6\n");
      if (argv[0] === "xcode-select") return ok("/Library/Developer/CommandLineTools\n");
      if (argv[0] === "git") return ok("git version 2.43.0\n");
      return ok();
    };
    const r = await pickRow(macRows(fakeProbes({ exec: execScript })), "tool.clt");
    expect(r.status).toBe("ready");
    expect(r.detail).toContain("2.43.0");
    expect(r.required).toBe(true);
  });

  test("xcode-select 127 -> missing with install action via apple-clt", async () => {
    const execScript: ExecScript = (argv) => {
      if (argv[0] === "sw_vers") return ok("15.6\n");
      if (argv[0] === "xcode-select") return missing("xcode-select");
      if (argv[0] === "git") return ok("git version 2.43.0\n");
      return ok();
    };
    const r = await pickRow(macRows(fakeProbes({ exec: execScript })), "tool.clt");
    expect(r.status).toBe("missing");
    expect(r.detail).toBe("Apple command line tools not installed");
    expect(r.action).toEqual({ type: "install", label: "Install…", tool: "apple-clt", via: "apple-clt" });
  });

  test("git --version failing even with CLT selected -> missing", async () => {
    const execScript: ExecScript = (argv) => {
      if (argv[0] === "sw_vers") return ok("15.6\n");
      if (argv[0] === "xcode-select") return ok("/Library/Developer/CommandLineTools\n");
      if (argv[0] === "git") return missing("git");
      return ok();
    };
    const r = await pickRow(macRows(fakeProbes({ exec: execScript })), "tool.clt");
    expect(r.status).toBe("missing");
  });
});

describe("macRows — tool.arch", () => {
  test("arm64 -> ready", async () => {
    const execScript: ExecScript = (argv) => (argv[0] === "uname" ? ok("arm64\n") : ok());
    const r = await pickRow(macRows(fakeProbes({ exec: execScript })), "tool.arch");
    expect(r.status).toBe("ready");
    expect(r.detail).toContain("arm64");
    expect(r.required).toBe(true);
  });

  test("x86_64 -> invalid, unsupported architecture", async () => {
    const execScript: ExecScript = (argv) => (argv[0] === "uname" ? ok("x86_64\n") : ok());
    const r = await pickRow(macRows(fakeProbes({ exec: execScript })), "tool.arch");
    expect(r.status).toBe("invalid");
  });

  test("uname unreachable -> error, never invalid (couldn't determine, not a failed determination)", async () => {
    const execScript: ExecScript = (argv) => (argv[0] === "uname" ? missing("uname") : ok());
    const r = await pickRow(macRows(fakeProbes({ exec: execScript })), "tool.arch");
    expect(r.status).toBe("error");
  });
});

describe("macRows — tool.path", () => {
  test("~/.local/bin first on PATH and the precedence marker present -> ready", async () => {
    const p = fakeProbes({
      env: { PATH: "/fake-home/.local/bin:/usr/bin" },
      files: { [RC]: `\n${MARKER}\nexport PATH=...\n` },
      dirs: { "/fake-home/.local/bin": [], "/usr/bin": [] },
    });
    const r = await pickRow(macRows(p), "tool.path");
    expect(r.status).toBe("ready");
    expect(r.kind).toBe("info");
    expect(r.required).toBe(false);
    expect(r.action).toBeNull();
    expect(r.detail).toContain(".zshenv");
  });

  test("PATH starting with /opt/homebrew/bin and a rc block present -> needs-you", async () => {
    const p = fakeProbes({
      env: { PATH: "/opt/homebrew/bin:/fake-home/.local/bin:/usr/bin" },
      files: { [RC]: `${MARKER}\n` },
      dirs: { "/opt/homebrew/bin": [], "/fake-home/.local/bin": [], "/usr/bin": [] },
    });
    const r = await pickRow(macRows(p), "tool.path");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("not first");
  });

  test("marker absent from ~/.zshenv -> missing", async () => {
    const p = fakeProbes({
      env: { PATH: "/fake-home/.local/bin:/usr/bin" },
      dirs: { "/fake-home/.local/bin": [], "/usr/bin": [] },
    });
    const r = await pickRow(macRows(p), "tool.path");
    expect(r.status).toBe("missing");
    expect(r.detail).toContain("Install adds ~/.local/bin");
  });
});
