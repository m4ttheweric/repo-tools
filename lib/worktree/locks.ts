export interface Locks {
  tryLockTree(path: string): (() => void) | null;
  isTreeLocked(path: string): boolean;
  withTreeLock<T>(path: string, fn: () => Promise<T>): Promise<T | "busy">;
}

/**
 * R031: an independent lock table, isolated from every other createLocks()
 * instance (and from the default one the free functions below share).
 */
export function createLocks(): Locks {
  const locks = new Map<string, symbol>();

  function tryLockTree(path: string): (() => void) | null {
    if (locks.has(path)) {
      return null;
    }
    const token = Symbol("lock");
    locks.set(path, token);
    return () => {
      // Only delete if the token still matches (ownership check prevents stale releases)
      if (locks.get(path) === token) {
        locks.delete(path);
      }
    };
  }

  function isTreeLocked(path: string): boolean {
    return locks.has(path);
  }

  async function withTreeLock<T>(
    path: string,
    fn: () => Promise<T>,
  ): Promise<T | "busy"> {
    const release = tryLockTree(path);
    if (release === null) {
      return "busy";
    }

    try {
      const result = await fn();
      return result;
    } finally {
      release();
    }
  }

  return { tryLockTree, isTreeLocked, withTreeLock };
}

let defaultLocks: Locks | null = null;

function getDefaultLocks(): Locks {
  return defaultLocks ??= createLocks();
}

export function tryLockTree(path: string): (() => void) | null {
  return getDefaultLocks().tryLockTree(path);
}

export function isTreeLocked(path: string): boolean {
  return getDefaultLocks().isTreeLocked(path);
}

export function withTreeLock<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T | "busy"> {
  return getDefaultLocks().withTreeLock(path, fn);
}
