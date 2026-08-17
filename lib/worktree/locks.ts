const locks = new Map<string, symbol>();

export function tryLockTree(path: string): (() => void) | null {
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

export function isTreeLocked(path: string): boolean {
  return locks.has(path);
}

export async function withTreeLock<T>(
  path: string,
  fn: () => Promise<T>
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
