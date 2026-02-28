#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

const workspaceRoot =
  gitRoot.status === 0
    ? gitRoot.stdout.trim()
    : resolve(dirname(import.meta.dir), '..');

console.log(`Running pnpm install in ${workspaceRoot}`);

const result = spawnSync('pnpm', ['install'], {
  cwd: workspaceRoot,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
