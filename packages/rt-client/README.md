# @mattstack/rt-client

Typed client for the [rt](https://rt.cool) daemon.

rt keeps the per-repo state a dev environment needs: worktrees, assigned ports,
tokens, dev servers, and a live event relay. This package is how other programs
read and drive that state without shelling out to the CLI and parsing text.

```bash
bun add @mattstack/rt-client
```

```ts
import { rtCommand, readProjectMRs } from '@mattstack/rt-client';

const repos = await rtCommand(['repos', 'list']);
const mrs = await readProjectMRs('group/repo');
```

Requires a running rt daemon. Install rt from the latest GitHub Release
(`./rt --post-install`), then `rt verify`.

Bun-only: the settings exec path (`src/settings/exec.ts`) shells out via
`Bun.spawn`, so this package does not run under Node.

`@mattstack/glance` is a peer dependency: rt-client returns glance's forge types
so merge request shapes stay identical across rt, gitq, and mr-board.

## License

MIT
