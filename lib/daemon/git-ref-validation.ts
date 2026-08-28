/**
 * Rejects a branch/ref string that git would parse as an OPTION rather than
 * a ref. A caller-supplied `branch` like "--upload-pack=touch /tmp/x" reaches
 * `git fetch origin <branch>` and `git rev-list ...<branch>...` unescaped,
 * and git happily executes it as an option since nothing on that path
 * validates the string first. This is the one guard both call sites need;
 * any future caller (including a consumer app forwarding an untrusted string
 * as `branch`) inherits the same hole without it.
 *
 * Deliberately narrow: reject a leading '-' rather than allowlisting a
 * character set. `git check-ref-format --branch` accepts far more
 * punctuation than is worth re-deriving here, and the vulnerable shape is
 * specifically "parses as an option", not "contains an unusual character".
 */
export function isSafeGitRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith("-");
}

export function validateGitRef(ref: string): { ok: true } | { ok: false; error: string } {
  if (!isSafeGitRef(ref)) {
    return { ok: false, error: `unsafe git ref (starts with '-' or empty): ${ref}` };
  }
  return { ok: true };
}
