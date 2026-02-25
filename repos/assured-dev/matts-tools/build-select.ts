#!/usr/bin/env bun

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const HISTORY_PATH = join(ROOT, '.cursor_me', 'build-history.json');

const esc = (code: number): string => `\x1b[${code}m`;
const reset = esc(0);
const bold = esc(1);
const dim = esc(2);
const cyan = esc(36);
const green = esc(32);
const yellow = esc(33);
const magenta = esc(35);
const white = esc(37);

const CHECKBOX_ON = `${green}◉${reset}`;
const CHECKBOX_OFF = `${dim}○${reset}`;
const POINTER = `${cyan}❯${reset}`;
const BLANK = ' ';

interface Package {
  name: string;
  path: string;
}

interface HistoryEntry {
  lastBuilt: number;
  count: number;
}

type History = Record<string, HistoryEntry>;

type DisplayItem =
  | { type: 'header'; label: string }
  | { type: 'separator' }
  | { type: 'pkg'; pkg: Package; tag: string | null };

function loadHistory(): History {
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveHistory(selectedNames: string[]): void {
  const history = loadHistory();
  const now = Date.now();
  for (const name of selectedNames) {
    history[name] = {
      lastBuilt: now,
      count: (history[name]?.count ?? 0) + 1,
    };
  }
  mkdirSync(join(ROOT, '.cursor_me'), { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function getRecentPackages(packages: Package[]): Package[] {
  const history = loadHistory();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return packages
    .filter((p) => history[p.name]?.lastBuilt > cutoff)
    .sort(
      (a, b) =>
        (history[b.name]?.lastBuilt ?? 0) -
        (history[a.name]?.lastBuilt ?? 0),
    );
}

function getPackages(): Package[] {
  const yaml = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const paths = yaml
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());

  return paths
    .map((pkgPath): Package | null => {
      try {
        const pkg = JSON.parse(
          readFileSync(join(ROOT, pkgPath, 'package.json'), 'utf8'),
        );
        return { name: pkg.name, path: pkgPath };
      } catch {
        return null;
      }
    })
    .filter((p): p is Package => p !== null)
    .filter((p) => p.path.startsWith('packages/'))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function groupByDirectory(packages: Package[]): Map<string, Package[]> {
  const groups = new Map<string, Package[]>();
  for (const pkg of packages) {
    const dir = pkg.path.split('/')[0];
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(pkg);
  }
  return groups;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function render(
  packages: Package[],
  _groups: Map<string, Package[]>,
  cursor: number,
  selected: Set<string>,
  searchTerm: string | null,
  recentPackages: Package[],
): { lines: string[]; filtered: Package[] } {
  const lines: string[] = [];
  const history = loadHistory();

  lines.push('');
  lines.push(
    `  ${bold}${cyan}turbo build selector${reset}  ${dim}(↑↓ navigate, space select, a toggle all, / search, enter build)${reset}`,
  );
  lines.push('');

  if (searchTerm !== null) {
    lines.push(`  ${yellow}/${reset} ${searchTerm}${dim}▏${reset}`);
    lines.push('');
  }

  const isSearching = searchTerm !== null;
  const baseFiltered = isSearching
    ? packages.filter(
        (p) =>
          p.name.toLowerCase().includes(searchTerm!.toLowerCase()) ||
          p.path.toLowerCase().includes(searchTerm!.toLowerCase()),
      )
    : packages;

  const recentNames = new Set(recentPackages.map((p) => p.name));
  const hasRecent = recentPackages.length > 0 && !isSearching;

  const displayList: DisplayItem[] = [];

  if (hasRecent) {
    displayList.push({
      type: 'header',
      label: `${bold}${yellow}recent${reset}`,
    });
    for (const pkg of recentPackages) {
      const ago = history[pkg.name]
        ? timeAgo(history[pkg.name].lastBuilt)
        : '';
      displayList.push({
        type: 'pkg',
        pkg,
        tag: `${dim}${ago}${reset}`,
      });
    }
    displayList.push({ type: 'separator' });
  }

  let lastGroup: string | null = null;
  for (const pkg of baseFiltered) {
    if (hasRecent && recentNames.has(pkg.name)) continue;
    const group = pkg.path.split('/')[0];
    if (group !== lastGroup) {
      if (lastGroup !== null) displayList.push({ type: 'separator' });
      displayList.push({
        type: 'header',
        label: `${bold}${magenta}${group}/${reset}`,
      });
      lastGroup = group;
    }
    displayList.push({ type: 'pkg', pkg, tag: null });
  }

  if (isSearching && baseFiltered.length === 0) {
    displayList.push({
      type: 'header',
      label: `${dim}no matches${reset}`,
    });
  }

  const filtered: Package[] = [];
  let visibleIdx = 0;
  for (const item of displayList) {
    if (item.type === 'header') {
      lines.push(`  ${item.label}`);
    } else if (item.type === 'separator') {
      lines.push('');
    } else {
      filtered.push(item.pkg);
      const isActive = visibleIdx === cursor;
      const isSelected = selected.has(item.pkg.name);
      const pointer = isActive ? POINTER : BLANK;
      const checkbox = isSelected ? CHECKBOX_ON : CHECKBOX_OFF;
      const shortPath = item.pkg.path.split('/').slice(1).join('/');
      const label = isActive
        ? `${bold}${white}${shortPath}${reset} ${dim}${item.pkg.name}${reset}`
        : `${shortPath} ${dim}${item.pkg.name}${reset}`;
      const suffix = item.tag ? `  ${item.tag}` : '';
      lines.push(`  ${pointer} ${checkbox} ${label}${suffix}`);
      visibleIdx++;
    }
  }

  lines.push('');
  const count = selected.size;
  if (count > 0) {
    lines.push(
      `  ${green}${bold}${count}${reset} ${dim}package${count !== 1 ? 's' : ''} selected${reset}`,
    );
  } else {
    lines.push(`  ${dim}nothing selected${reset}`);
  }
  lines.push('');

  return { lines, filtered };
}

async function run(): Promise<string[]> {
  const packages = getPackages();
  const groups = groupByDirectory(packages);
  const recentPackages = getRecentPackages(packages);

  if (packages.length === 0) {
    console.log(`${yellow}no packages found${reset}`);
    process.exit(1);
  }

  let cursor = 0;
  const selected = new Set<string>();
  let searchTerm: string | null = null;
  let filtered = packages;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdout.write('\x1b[?25l');

  let lastLineCount = 0;

  function draw(): void {
    if (lastLineCount > 0) {
      process.stdout.write(`\x1b[${lastLineCount}A`);
      process.stdout.write('\x1b[0J');
    }

    const result = render(
      packages,
      groups,
      cursor,
      selected,
      searchTerm,
      recentPackages,
    );
    filtered = result.filtered;
    const output = result.lines.join('\n');
    process.stdout.write(output + '\n');
    lastLineCount = result.lines.length;
  }

  function cleanup(): void {
    process.stdout.write('\x1b[?25h');
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  draw();

  return new Promise<string[]>((resolve) => {
    process.stdin.on('data', (key: string) => {
      if (searchTerm !== null) {
        if (key === '\r' || key === '\n') {
          searchTerm = null;
          cursor = 0;
          draw();
          return;
        }
        if (key === '\x1b') {
          searchTerm = null;
          cursor = 0;
          draw();
          return;
        }
        if (key === '\x7f') {
          searchTerm = searchTerm.slice(0, -1);
          if (searchTerm.length === 0) searchTerm = null;
          cursor = 0;
          draw();
          return;
        }
        if (key.length === 1 && key >= ' ') {
          searchTerm += key;
          cursor = 0;
          draw();
          return;
        }
        return;
      }

      if (key === '\x03' || key === 'q') {
        cleanup();
        console.log(`\n  ${dim}cancelled${reset}\n`);
        process.exit(0);
      }

      if (key === '\r' || key === '\n') {
        cleanup();
        if (selected.size === 0) {
          console.log(`\n  ${yellow}nothing selected, exiting${reset}\n`);
          process.exit(0);
        }
        resolve([...selected]);
        return;
      }

      if (key === '/') {
        searchTerm = '';
        cursor = 0;
        draw();
        return;
      }

      if (key === 'a') {
        const target = filtered.length > 0 ? filtered : packages;
        const allSelected = target.every((p) => selected.has(p.name));
        for (const p of target) {
          if (allSelected) selected.delete(p.name);
          else selected.add(p.name);
        }
        draw();
        return;
      }

      if (key === ' ') {
        if (filtered.length > 0) {
          const pkg = filtered[cursor];
          if (selected.has(pkg.name)) selected.delete(pkg.name);
          else selected.add(pkg.name);
        }
        draw();
        return;
      }

      if (key === '\x1b[A' || key === 'k') {
        cursor = Math.max(0, cursor - 1);
        draw();
        return;
      }
      if (key === '\x1b[B' || key === 'j') {
        cursor = Math.min(filtered.length - 1, cursor + 1);
        draw();
        return;
      }
    });
  });
}

const selectedPackages = await run();
const filters = selectedPackages.map((p) => `--filter=${p}`).join(' ');

console.log('');
console.log(
  `  ${bold}${cyan}building ${selectedPackages.length} package${selectedPackages.length !== 1 ? 's' : ''}...${reset}`,
);
console.log(`  ${dim}pnpm turbo run build ${filters}${reset}`);
console.log('');

try {
  execSync(`pnpm turbo run build ${filters}`, {
    cwd: ROOT,
    stdio: 'inherit',
  });
  saveHistory(selectedPackages);
} catch {
  process.exit(1);
}
