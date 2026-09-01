import { describe, expect, test } from "bun:test";
import { decidePlacement, openSmartPane, type HerdrCall } from "../smart-pane.ts";

describe("decidePlacement", () => {
  test("null rect falls back to a right split", () => {
    expect(decidePlacement(null)).toEqual({ kind: "split", direction: "right" });
  });

  test("a lone pane (204x81) splits right", () => {
    expect(decidePlacement({ width: 204, height: 81 })).toEqual({ kind: "split", direction: "right" });
  });

  test("a two-column pane (102x81) splits down", () => {
    expect(decidePlacement({ width: 102, height: 81 })).toEqual({ kind: "split", direction: "down" });
  });

  test("a narrower pane (68x81) splits down", () => {
    expect(decidePlacement({ width: 68, height: 81 })).toEqual({ kind: "split", direction: "down" });
  });

  test("a tiny pane (40x20) spills to a tab", () => {
    expect(decidePlacement({ width: 40, height: 20 })).toEqual({ kind: "tab" });
  });

  test("wide but short (300x20): can go right but not down, so right wins", () => {
    expect(decidePlacement({ width: 300, height: 20 })).toEqual({ kind: "split", direction: "right" });
  });

  test("narrow but tall (60x120) with default mins: can go down but not right, so down wins", () => {
    expect(decidePlacement({ width: 60, height: 120 })).toEqual({ kind: "split", direction: "down" });
  });

  test("respects custom minCols/minRows", () => {
    // 60x30 clears the defaults (>=100 wide, >=28 tall would be needed) but
    // fails a stricter custom floor, so it spills to a tab instead.
    expect(decidePlacement({ width: 60, height: 30 }, { minCols: 40, minRows: 20 })).toEqual({ kind: "tab" });
  });
});

describe("openSmartPane", () => {
  function fakeHerdr(overrides: Partial<Record<string, (params: Record<string, unknown>) => any>> = {}): {
    herdr: HerdrCall;
    calls: { method: string; params: Record<string, unknown> }[];
  } {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const herdr: HerdrCall = async (method, params) => {
      calls.push({ method, params });
      if (overrides[method]) return overrides[method]!(params);
      if (method === "pane.layout") {
        return { ok: true, result: { layout: { panes: [{ pane_id: params.pane_id, rect: { width: 102, height: 81 } }] } } };
      }
      if (method === "pane.split") return { ok: true, result: { pane: { pane_id: "%new" } } };
      if (method === "tab.create") return { ok: true, result: { root_pane: { pane_id: "%new-tab" } } };
      return { ok: true, result: {} };
    };
    return { herdr, calls };
  }

  test("a rect that decides down issues pane.split direction down", async () => {
    const { herdr, calls } = fakeHerdr();
    const outcome = await openSmartPane(herdr, "ws1:%0");
    expect(outcome).toEqual({ paneId: "%new", placement: { kind: "split", direction: "down" } });
    expect(calls[1]).toEqual({ method: "pane.split", params: { pane_id: "ws1:%0", direction: "down", focus: true } });
  });

  test("a crowded rect issues tab.create with the anchor's workspace id", async () => {
    const { herdr, calls } = fakeHerdr({
      "pane.layout": (params) => ({ ok: true, result: { layout: { panes: [{ pane_id: params.pane_id, rect: { width: 40, height: 20 } }] } } }),
    });
    const outcome = await openSmartPane(herdr, "ws1:%0");
    expect(outcome).toEqual({ paneId: "%new-tab", placement: { kind: "tab" } });
    expect(calls[1]).toEqual({ method: "tab.create", params: { workspace_id: "ws1", focus: true } });
  });

  test("command triggers send_text followed by send_keys(enter)", async () => {
    const { herdr, calls } = fakeHerdr();
    await openSmartPane(herdr, "ws1:%0", { command: "echo hi" });
    expect(calls.slice(1)).toEqual([
      { method: "pane.split", params: { pane_id: "ws1:%0", direction: "down", focus: true } },
      { method: "pane.send_text", params: { pane_id: "%new", text: "echo hi" } },
      { method: "pane.send_keys", params: { pane_id: "%new", keys: ["enter"] } },
    ]);
  });

  test("a missing pane_id in the split reply throws", async () => {
    const { herdr } = fakeHerdr({ "pane.split": () => ({ ok: true, result: { pane: {} } }) });
    await expect(openSmartPane(herdr, "ws1:%0")).rejects.toThrow("pane.split returned no pane_id");
  });

  test("a missing pane_id in the tab.create reply throws", async () => {
    const { herdr } = fakeHerdr({
      "pane.layout": (params) => ({ ok: true, result: { layout: { panes: [{ pane_id: params.pane_id, rect: { width: 40, height: 20 } }] } } }),
      "tab.create": () => ({ ok: true, result: { root_pane: {} } }),
    });
    await expect(openSmartPane(herdr, "ws1:%0")).rejects.toThrow("tab.create returned no pane_id");
  });

  test("returns the chosen placement alongside the new pane id", async () => {
    const { herdr } = fakeHerdr({
      "pane.layout": (params) => ({ ok: true, result: { layout: { panes: [{ pane_id: params.pane_id, rect: { width: 204, height: 81 } }] } } }),
    });
    const outcome = await openSmartPane(herdr, "ws1:%0");
    expect(outcome.placement).toEqual({ kind: "split", direction: "right" });
  });
});
