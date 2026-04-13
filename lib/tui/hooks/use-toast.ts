/**
 * HOOK: useToast (Ink / React)
 *
 * Manages a timed ephemeral toast message for Ink (React) dashboards.
 * The toast auto-clears after `ms` milliseconds.
 *
 * For Rezi dashboards (e.g. rt runner), use the imperative pattern instead:
 *
 *   function showToast(msg: string, ms = 2500) {
 *     safeUpdate((s) => ({ ...s, toast: msg }));
 *     setTimeout(() => safeUpdate((s) => ({ ...s, toast: null })), ms);
 *   }
 *
 * Source: commands/runner.tsx showToast (line 485)
 */

import { useState, useCallback, useRef } from "react";

export interface ToastController {
  /** Currently displayed message, or null. */
  message: string | null;
  /** Show a toast for `ms` milliseconds (default 2500ms). */
  show: (msg: string, ms?: number) => void;
  /** Clear the toast immediately. */
  clear: () => void;
}

/**
 * @returns A toast controller with { message, show, clear }.
 *
 * @example
 * ```tsx
 * const toast = useToast();
 * // ...
 * toast.show("Branch switched!");
 * // ...
 * {toast.message && <Text color="yellow">{toast.message}</Text>}
 * ```
 */
export function useToast(): ToastController {
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((msg: string, ms = 2500) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMessage(msg);
    timerRef.current = setTimeout(() => setMessage(null), ms);
  }, []);

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMessage(null);
  }, []);

  return { message, show, clear };
}
