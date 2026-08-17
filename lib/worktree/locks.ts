const locks = new Map<string, true>();

export function tryLockTree(path: string): (() => void) | null {
  if (locks.has(path)) {
    return null;
  }
  locks.set(path, true);
  return () => {
    locks.delete(path);
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
