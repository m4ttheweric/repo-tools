import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getSetting, setSetting } from '@mattstack/rt-client';
import { loadBranchNamingConfig } from '../branchNaming';

// @mattstack/rt-client does not export its store-path helpers (paths.ts is
// an internal detail); these are the documented layout from
// docs/settings-architecture.md's store table.
const userSettingsPath = (home: string) => join(home, '.mattstack', 'user', 'settings.user.jsonc');
const teamSettingsPath = (home: string, team: string) =>
  join(home, '.mattstack', 'teams', team, 'mattstack', 'settings.team.jsonc');

// Every test repoints HOME at a fresh temp dir (call-time HOME resolution,
// same convention as rt-client's own settings tests) so the settings store
// this exercises is never the real ~/.mattstack.
const IDENTITY = 'github.com/example/repo';

describe('loadBranchNamingConfig', () => {
  const origHome = process.env.HOME;
  let home: string;
  let dataDir: string;
  let warnSpy: ReturnType<typeof spyOn<Console, 'warn'>>;
  let errorSpy: ReturnType<typeof spyOn<Console, 'error'>>;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'rt-context-branch-naming-')));
    process.env.HOME = home;
    dataDir = join(home, 'data');
    mkdirSync(dataDir, { recursive: true });
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    // setSetting prints a "wrote to the local store" reminder via console.error
    // on every successful write; not under test here, just noise.
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  const legacyPath = () => join(dataDir, 'branch-naming.json');
  const writeLegacy = (contents: string) => writeFileSync(legacyPath(), contents);

  /** A cloned team store, so `setSetting(..., "team", ...)`'s single-team auto-detection has exactly one candidate. */
  function seedTeamStore(team: string): void {
    const path = teamSettingsPath(home, team);
    mkdirSync(join(home, '.mattstack', 'teams', team, 'mattstack'), { recursive: true });
    writeFileSync(path, '{}\n');
  }

  test('no store value, no legacy file -> null', () => {
    expect(loadBranchNamingConfig(dataDir, IDENTITY)).toBeNull();
  });

  test('no store value, valid legacy file, exactly one cloned team -> imports into the team.repo rung, renames the file, and returns the template', () => {
    seedTeamStore('acme');
    writeLegacy(JSON.stringify({ template: '${teamPrefix}-${ticketNumber}' }));

    const result = loadBranchNamingConfig(dataDir, IDENTITY);

    expect(result).toEqual({ template: '${teamPrefix}-${ticketNumber}' });
    expect(existsSync(legacyPath())).toBe(false);
    expect(existsSync(`${legacyPath()}.migrated`)).toBe(true);

    const persisted = getSetting<{ template: string }>('rt.branchNaming', { repoIdentity: IDENTITY }).value;
    expect(persisted).toEqual({ template: '${teamPrefix}-${ticketNumber}' });

    const teamStoreRaw = JSON.parse(readFileSync(teamSettingsPath(home, 'acme'), 'utf8'));
    expect(teamStoreRaw.repos[IDENTITY]['rt.branchNaming']).toEqual({ template: '${teamPrefix}-${ticketNumber}' });
  });

  test('no store value, valid legacy file, no cloned team store -> setSetting refuses; returns the template from the file, leaves it in place, warns', () => {
    writeLegacy(JSON.stringify({ template: '${identifier}-legacy' }));

    const result = loadBranchNamingConfig(dataDir, IDENTITY);

    expect(result).toEqual({ template: '${identifier}-legacy' });
    expect(existsSync(legacyPath())).toBe(true);
    expect(existsSync(`${legacyPath()}.migrated`)).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  test('store already owns the key -> store wins, legacy file (even if present) is left untouched', () => {
    // Ownership doesn't care WHICH scope owns the key; hand-authoring straight
    // into the user store is the simplest fixture for "the store already has
    // a value" regardless of which rung a real import would target.
    setSetting('rt.branchNaming', { template: '${identifier}-store' }, 'user', { repoIdentity: IDENTITY });
    writeLegacy(JSON.stringify({ template: '${identifier}-legacy' }));

    const result = loadBranchNamingConfig(dataDir, IDENTITY);

    expect(result).toEqual({ template: '${identifier}-store' });
    expect(existsSync(legacyPath())).toBe(true);
    expect(existsSync(`${legacyPath()}.migrated`)).toBe(false);
  });

  test('store owns the key but the value is malformed -> null, no fallback to the legacy file', () => {
    // Hand-author a store value that fails the same `{template: string}`
    // validation a file value would fail — the ownership latch means the
    // store already won, so this must not fall through to the legacy file.
    mkdirSync(join(home, '.mattstack', 'user'), { recursive: true });
    writeFileSync(
      userSettingsPath(home),
      JSON.stringify({ repos: { [IDENTITY]: { 'rt.branchNaming': { template: 42 } } } }),
    );
    writeLegacy(JSON.stringify({ template: '${identifier}-legacy' }));

    const result = loadBranchNamingConfig(dataDir, IDENTITY);

    expect(result).toBeNull();
    expect(existsSync(legacyPath())).toBe(true);
  });

  test('resolver probe failure (an unexpandable authored variable) counts as unowned -> falls back to the legacy file', () => {
    // ${worktree} is one of the resolver's own closed-set variables; resolving
    // it with no worktree context throws, which must degrade to "unowned"
    // rather than propagate.
    setSetting('rt.branchNaming', { template: '${worktree}' }, 'user', { repoIdentity: IDENTITY });
    writeLegacy(JSON.stringify({ template: '${identifier}-legacy' }));

    const result = loadBranchNamingConfig(dataDir, IDENTITY);

    expect(result).toEqual({ template: '${identifier}-legacy' });
  });

  test('legacy file is corrupt JSON -> warns, returns null, leaves the file in place', () => {
    writeLegacy('{ not json');

    const result = loadBranchNamingConfig(dataDir, IDENTITY);

    expect(result).toBeNull();
    expect(existsSync(legacyPath())).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  test('legacy file parses but has no usable template -> null, no migration attempted', () => {
    writeLegacy(JSON.stringify({ template: '   ' }));

    const result = loadBranchNamingConfig(dataDir, IDENTITY);

    expect(result).toBeNull();
    expect(existsSync(legacyPath())).toBe(true);
  });

  test('null repo identity with a valid legacy file -> returns the template, never attempts migration', () => {
    seedTeamStore('acme');
    writeLegacy(JSON.stringify({ template: '${identifier}-legacy' }));

    const result = loadBranchNamingConfig(dataDir, null);

    expect(result).toEqual({ template: '${identifier}-legacy' });
    expect(existsSync(legacyPath())).toBe(true);
    expect(existsSync(`${legacyPath()}.migrated`)).toBe(false);
  });

  test('never throws: dataDir itself does not exist', () => {
    expect(() => loadBranchNamingConfig(join(home, 'nonexistent'), IDENTITY)).not.toThrow();
    expect(loadBranchNamingConfig(join(home, 'nonexistent'), IDENTITY)).toBeNull();
  });
});
