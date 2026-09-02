# rt skills compile

`rt skills compile` turns engine sources (mattstack `type: pipeline-step` skills) plus a manifest's bindings into committed `SKILL.md` files under a pack's `skills/` (surface-public) and `attachments/` (internal) directories. `commands/skills.ts` resolves the pack, roster, manifest and targets; `compileSkill` in `compile.ts` assembles one target and lints it; `placeholders.ts` renders the `{{...}}` markers.

## Where `${CLAUDE_SKILL_DIR}` points

Claude sets `${CLAUDE_SKILL_DIR}` to the directory of the skill it *invoked*. Only surface-public roster verbs are invoked by name, so only their compiled bodies may use the token as their own directory. Every other target is read as a file by a public skill, so the compiler rewrites its `${CLAUDE_SKILL_DIR}/...` references to the directory a pack-side reader reaches it at:

| Target | Host dir the body is rewritten to |
| --- | --- |
| public roster verb | `${CLAUDE_SKILL_DIR}` (unchanged) |
| stage listed public in `surface.jsonc` | `${CLAUDE_SKILL_DIR}/../../skills/<name>` |
| stage not listed public | `${CLAUDE_SKILL_DIR}/../../attachments/<name>` |
| internal roster verb | `${CLAUDE_SKILL_DIR}/../../attachments/<name>` |

Fills and includes vendored into such a target land under `<host dir>/parts/<slot or include-name>/`, and their own `${CLAUDE_SKILL_DIR}` references are rewritten to that parts dir. `{{stage.dir}}` renders the host dir inside any attachments-side target and is an error in a public verb. The host dirs of every stage and every internal roster verb are exempt from the emitted-file lint, so a target that vendors a fill or include lints clean.

Known limit: the `../../` hop assumes the reader's own skill lives at `<pack>/skills/<reader>`. A reader outside the pack (another plugin's skill) resolves `${CLAUDE_SKILL_DIR}/../../...` against its own plugin, so pack text meant to be read from outside must name files relative to itself instead.

## `{{verb.path:<name>}}`

Renders the path from the current output file's directory to `<name>`'s compiled `SKILL.md`: `../<name>/SKILL.md` when both targets sit on the same side, `../../skills/<name>/SKILL.md` or `../../attachments/<name>/SKILL.md` across sides. It is a reading path, relative to the file that carries it, never a shell path. `<name>` must match `[a-z][a-z0-9-]*` and be a compiled target of this pack (roster verb or stage); a `--verb` or `--preview` compile still resolves paths to targets it is not emitting, and its lint may then report them as not emitted. Allowed in engine bodies and in fills.

## `{{pack.path:<attachment>/<file>}}`

Renders `${CLAUDE_SKILL_DIR}/../../<side>/<attachment>/<file>`, anchored on the invoking skill's dir so it works inside a shell command from any public skill in the pack. `<attachment>` must be an existing directory under exactly one of the pack's `attachments/` or `skills/` (that picks `<side>`; both is an error), must not name a compiled target (its output exists only after a compile), and `<pack>/<side>/<attachment>/<file>` must exist when the compile runs; `<file>` is one or more segments with no `..`. Rendered paths are exempt from the emitted-file lint. Allowed in engine bodies and in fills; a fill's `${CLAUDE_SKILL_DIR}` rewrite runs before substitution, so a rendered path is never rewritten to a parts dir.
