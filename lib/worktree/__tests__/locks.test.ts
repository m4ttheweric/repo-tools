import { describe, it, expect } from "bun:test";
import { tryLockTree, isTreeLocked, withTreeLock } from "../locks";

describe("tryLockTree", () => {
  it("acquires lock and returns release function on first call", () => {
    const path = "/test/tree/1";
    const release = tryLockTree(path);
    expect(release).not.toBeNull();
    expect(typeof release).toBe("function");
    release?.();
  });

  it("returns null when trying to acquire already-held lock", () => {
    const path = "/test/tree/2";
    const release1 = tryLockTree(path);
    expect(release1).not.toBeNull();

    const release2 = tryLockTree(path);
    expect(release2).toBeNull();

    release1?.();
  });

  it("allows re-acquiring lock after release", () => {
    const path = "/test/tree/3";
    const release1 = tryLockTree(path);
    expect(release1).not.toBeNull();
    release1?.();

    const release2 = tryLockTree(path);
    expect(release2).not.toBeNull();
    release2?.();
  });
});

describe("isTreeLocked", () => {
  it("returns false when tree is not locked", () => {
    const path = "/test/tree/4";
    expect(isTreeLocked(path)).toBe(false);
  });

  it("returns true when tree is locked", () => {
    const path = "/test/tree/5";
    const release = tryLockTree(path);
    expect(isTreeLocked(path)).toBe(true);
    release?.();
  });

  it("returns false after lock is released", () => {
    const path = "/test/tree/6";
    const release = tryLockTree(path);
    release?.();
    expect(isTreeLocked(path)).toBe(false);
  });
});

describe("withTreeLock", () => {
  it("executes function when lock is acquired", async () => {
    const path = "/test/tree/7";
    let executed = false;
    const result = await withTreeLock(path, async () => {
      executed = true;
      return "success";
    });
    expect(executed).toBe(true);
    expect(result).toBe("success");
  });

  it("returns 'busy' when lock is already held", async () => {
    const path = "/test/tree/8";
    const release = tryLockTree(path);
    expect(release).not.toBeNull();

    const result = await withTreeLock(path, async () => {
      return "should not execute";
    });
    expect(result).toBe("busy");

    release?.();
  });

  it("releases lock after function resolves", async () => {
    const path = "/test/tree/9";
    await withTreeLock(path, async () => {
      expect(isTreeLocked(path)).toBe(true);
      return "done";
    });
    expect(isTreeLocked(path)).toBe(false);
  });

  it("releases lock when function throws", async () => {
    const path = "/test/tree/10";
    try {
      await withTreeLock(path, async () => {
        expect(isTreeLocked(path)).toBe(true);
        throw new Error("test error");
      });
    } catch {
      // Expected to throw
    }
    expect(isTreeLocked(path)).toBe(false);
  });

  it("does not acquire lock when returning 'busy'", async () => {
    const path = "/test/tree/11";
    const release1 = tryLockTree(path);
    expect(release1).not.toBeNull();

    const result = await withTreeLock(path, async () => {
      return "should not execute";
    });
    expect(result).toBe("busy");
    expect(isTreeLocked(path)).toBe(true);

    release1?.();
    expect(isTreeLocked(path)).toBe(false);
  });

  it("regression: stale release does not steal new holder's lock", () => {
    // A acquires lock
    const path = "/test/tree/12";
    const releaseA = tryLockTree(path);
    expect(releaseA).not.toBeNull();
    expect(isTreeLocked(path)).toBe(true);

    // A releases
    releaseA?.();
    expect(isTreeLocked(path)).toBe(false);

    // B acquires the same lock
    const releaseB = tryLockTree(path);
    expect(releaseB).not.toBeNull();
    expect(isTreeLocked(path)).toBe(true);

    // A's stale release fires again (e.g., from catch+finally or retry logic)
    releaseA?.();
    // B's lock should still be held (not stolen by A's stale release)
    expect(isTreeLocked(path)).toBe(true);

    // B's release should still work
    releaseB?.();
    expect(isTreeLocked(path)).toBe(false);
  });
});
