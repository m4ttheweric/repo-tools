import { describe, expect, test } from 'bun:test';
import { parseWorktreePorcelain } from '../worktreeParse';

// Real-shape `git worktree list --porcelain` output: a branch worktree,
// detached worktrees (warm-pool entries), and a bare main repo. The old
// human-readable regex parser silently dropped every detached entry because
// it required a trailing `[branch]`.
const PORCELAIN = `worktree /Users/matt/Documents/GitHub/acme/api
HEAD fbf2aad438e26403d984c2fbc52702bc6eb46efc
branch refs/heads/feature/acme-2137-darkness-factor-headlight-source

worktree /Users/matt/Documents/GitHub/acme/draco
HEAD deab8112ffee167e7bc5c9df8d16dfe3e1ba9a14
detached

worktree /Users/matt/Documents/GitHub/acme/dumbledore
HEAD 9747cd6b89ea9772c8864143f67d7010f4e460dc
branch refs/heads/parking-lot/4
`;

describe('parseWorktreePorcelain', () => {
  test('includes detached-HEAD worktrees with a null branch', () => {
    const entries = parseWorktreePorcelain(PORCELAIN, 'harry');
    const names = entries.map((e) => e.name);

    expect(names).toEqual(['harry', 'draco', 'dumbledore']);

    const draco = entries.find((e) => e.name === 'draco')!;
    expect(draco.branch).toBeNull();
    expect(draco.dirPath).toBe('/Users/matt/Documents/GitHub/acme/draco');
  });

  test('resolves branch names and flags the current worktree', () => {
    const entries = parseWorktreePorcelain(PORCELAIN, 'harry');

    const harry = entries.find((e) => e.name === 'harry')!;
    expect(harry.branch).toBe('feature/acme-2137-darkness-factor-headlight-source');
    expect(harry.isCurrent).toBe(true);

    const dumbledore = entries.find((e) => e.name === 'dumbledore')!;
    expect(dumbledore.branch).toBe('parking-lot/4');
    expect(dumbledore.isCurrent).toBe(false);
  });

  test('skips the bare main-repo entry', () => {
    const bare = `worktree /Users/matt/repo.git
bare

worktree /Users/matt/repo/feature
HEAD abc123
branch refs/heads/feature
`;
    const entries = parseWorktreePorcelain(bare, 'feature');
    expect(entries.map((e) => e.name)).toEqual(['feature']);
  });
});
