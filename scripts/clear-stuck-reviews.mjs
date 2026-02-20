#!/usr/bin/env node

import { execSync } from 'child_process';
import {
  existsSync,
  copyFileSync,
  readdirSync,
  unlinkSync,
  statSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

const WORKSPACE_DIR = join(
  homedir(),
  'Library/Application Support/Cursor/User/workspaceStorage/63cdc950b17a7629b4556ce9c1c753e4',
);
const DB = join(WORKSPACE_DIR, 'state.vscdb');
const SESSIONS_DIR = join(WORKSPACE_DIR, 'chatEditingSessions');
const BACKUP_DIR = join(
  new URL('.', import.meta.url).pathname.replace(/\/$/, ''),
  '.backups',
);

const esc = (code) => `\x1b[${code}m`;
const reset = esc(0);
const bold = esc(1);
const dim = esc(2);
const cyan = esc(36);
const green = esc(32);
const yellow = esc(33);
const red = esc(31);
const white = esc(37);

const CHECKBOX_ON = `${green}◉${reset}`;
const CHECKBOX_OFF = `${dim}○${reset}`;
const POINTER = `${cyan}❯${reset}`;
const BLANK = ' ';

const MAX_BACKUPS = 3;

// ============================================================================
// Backup management
// ============================================================================

function getBackups() {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('sessions-') && f.endsWith('.json'))
    .map((f) => {
      const full = join(BACKUP_DIR, f);
      const stat = statSync(full);
      const ts = f.replace('sessions-', '').replace('.json', '');
      return { file: f, path: full, timestamp: ts, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function createBackup(sessions) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = join(BACKUP_DIR, `sessions-${ts}.json`);

  const backupData = {};
  for (const s of sessions) {
    const stateFile = join(SESSIONS_DIR, s.id, 'state.json');
    if (existsSync(stateFile)) {
      backupData[s.id] = JSON.parse(readFileSync(stateFile, 'utf8'));
    }
  }
  writeFileSync(dest, JSON.stringify(backupData, null, 2));

  const backups = getBackups();
  while (backups.length > MAX_BACKUPS) {
    const old = backups.pop();
    unlinkSync(old.path);
  }

  return dest;
}

function restoreBackup(backupPath) {
  const data = JSON.parse(readFileSync(backupPath, 'utf8'));
  for (const [sessionId, state] of Object.entries(data)) {
    const stateFile = join(SESSIONS_DIR, sessionId, 'state.json');
    if (existsSync(join(SESSIONS_DIR, sessionId))) {
      writeFileSync(stateFile, JSON.stringify(state));
    }
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ============================================================================
// Session scanning
// ============================================================================

function getStuckSessions() {
  if (!existsSync(SESSIONS_DIR)) return [];

  const results = [];
  for (const dir of readdirSync(SESSIONS_DIR)) {
    const stateFile = join(SESSIONS_DIR, dir, 'state.json');
    if (!existsSync(stateFile)) continue;

    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      const pending = state.pendingSnapshot?.entries ?? [];
      if (pending.length === 0) continue;

      const unresolved = pending.filter((e) => e.state !== 2).length;
      if (unresolved === 0) continue;

      const sampleFile = pending[0]?.resource?.split('/').pop() ?? '';
      const mtime = statSync(stateFile).mtimeMs;

      results.push({
        id: dir,
        totalEntries: pending.length,
        unresolvedCount: unresolved,
        sampleFile,
        mtime,
      });
    } catch {
      continue;
    }
  }

  return results.sort((a, b) => b.unresolvedCount - a.unresolvedCount);
}

function clearSession(sessionId) {
  const stateFile = join(SESSIONS_DIR, sessionId, 'state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));

  if (state.pendingSnapshot?.entries) {
    state.pendingSnapshot.entries = [];
  }

  writeFileSync(stateFile, JSON.stringify(state));
}

function sql(query) {
  try {
    return execSync(`sqlite3 "${DB}" "${query.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function clearComposerDbState() {
  if (!existsSync(DB)) return;
  sql(`
    UPDATE ItemTable
    SET value = json_set(
      value,
      '$.allComposers',
      (
        SELECT json_group_array(
          json_set(j.value, '$.filesChangedCount', 0, '$.hasBlockingPendingActions', json('false'))
        )
        FROM json_each(ItemTable.value, '$.allComposers') j
        WHERE ItemTable.key = 'composer.composerData'
      )
    )
    WHERE key = 'composer.composerData'
  `);
}

// ============================================================================
// Cursor process helpers
// ============================================================================

function isCursorRunning() {
  try {
    execSync('pgrep -xq Cursor', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function promptKey(message) {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdout.write(message);
    process.stdin.once('data', (key) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      resolve(key);
    });
  });
}

async function ensureCursorClosed() {
  if (!isCursorRunning()) return true;

  console.log('');
  console.log(
    `  ${yellow}cursor is running.${reset} ${dim}it needs to be closed or it will overwrite the fix on exit.${reset}`,
  );
  const choice = await promptKey(`  ${dim}quit cursor now? (Y/n/c to cancel)${reset} `);

  if (choice === 'c' || choice === '\x03') {
    console.log(`\n  ${dim}cancelled${reset}\n`);
    process.exit(0);
  }

  if (choice === 'n') {
    console.log(`  ${dim}proceeding without closing cursor (changes may not stick).${reset}`);
    return true;
  }

  if (choice === 'y' || choice === '\r' || choice === '\n') {
    console.log(`  ${dim}sending quit signal to cursor...${reset}`);
    execSync('osascript -e \'tell application "Cursor" to quit\'', { stdio: 'pipe' });

    process.stdout.write(`  ${dim}waiting for cursor to close${reset}`);
    const timeout = Date.now() + 15000;
    while (isCursorRunning() && Date.now() < timeout) {
      execSync('sleep 1', { stdio: 'pipe' });
      process.stdout.write(`${dim}.${reset}`);
    }
    process.stdout.write('\n');

    if (isCursorRunning()) {
      console.log(`  ${red}cursor didn't quit in time. try closing it manually.${reset}`);
      process.exit(1);
    }
    console.log(`  ${green}cursor closed.${reset}`);
    return true;
  }

  return true;
}

async function offerRelaunchCursor() {
  console.log('');
  const choice = await promptKey(`  ${dim}reopen cursor? (Y/n)${reset} `);

  if (choice === 'n') {
    console.log('');
    return;
  }

  console.log(`  ${dim}opening cursor...${reset}`);
  execSync('open -a Cursor', { stdio: 'pipe' });
  console.log(`  ${green}done.${reset}`);
  console.log('');
}

// ============================================================================
// Time formatting
// ============================================================================

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatTimestamp(ts) {
  const parts = ts.split('T');
  if (parts.length === 2) return `${parts[0]} ${parts[1].replace(/-/g, ':')}`;
  return ts;
}

// ============================================================================
// Interactive UI
// ============================================================================

function interactiveSelect(title, hint, items, renderItem) {
  let cursor = 0;
  const selected = new Set();

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdout.write('\x1b[?25l');

  let lastLineCount = 0;

  function draw() {
    if (lastLineCount > 0) {
      process.stdout.write(`\x1b[${lastLineCount}A`);
      process.stdout.write('\x1b[0J');
    }
    const lines = ['', `  ${bold}${cyan}${title}${reset}  ${dim}${hint}${reset}`, ''];
    for (let i = 0; i < items.length; i++) {
      const isActive = i === cursor;
      const isSelected = selected.has(i);
      const pointer = isActive ? POINTER : BLANK;
      const checkbox = isSelected ? CHECKBOX_ON : CHECKBOX_OFF;
      lines.push(`  ${pointer} ${checkbox} ${renderItem(items[i], isActive)}`);
    }
    lines.push('');
    const count = selected.size;
    if (count > 0) {
      lines.push(`  ${green}${bold}${count}${reset} ${dim}selected${reset}`);
    } else {
      lines.push(`  ${dim}nothing selected${reset}`);
    }
    lines.push('');
    process.stdout.write(lines.join('\n') + '\n');
    lastLineCount = lines.length;
  }

  function cleanup() {
    process.stdout.write('\x1b[?25h');
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  draw();

  return new Promise((resolve) => {
    process.stdin.on('data', (key) => {
      if (key === '\x03' || key === 'q') {
        cleanup();
        console.log(`\n  ${dim}cancelled${reset}\n`);
        process.exit(0);
      }

      if (key === '\r' || key === '\n') {
        cleanup();
        resolve([...selected].map((i) => items[i]));
        return;
      }

      if (key === 'a') {
        const allSelected = items.every((_, i) => selected.has(i));
        for (let i = 0; i < items.length; i++) {
          if (allSelected) selected.delete(i);
          else selected.add(i);
        }
        draw();
        return;
      }

      if (key === ' ') {
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
        draw();
        return;
      }

      if (key === '\x1b[A' || key === 'k') {
        cursor = Math.max(0, cursor - 1);
        draw();
        return;
      }
      if (key === '\x1b[B' || key === 'j') {
        cursor = Math.min(items.length - 1, cursor + 1);
        draw();
        return;
      }
    });
  });
}

// ============================================================================
// Main menu
// ============================================================================

function renderMenu(items, cursor) {
  const lines = ['', `  ${bold}${cyan}cursor review tools${reset}`, ''];

  for (let i = 0; i < items.length; i++) {
    const isActive = i === cursor;
    const pointer = isActive ? POINTER : BLANK;
    const label = isActive
      ? `${bold}${white}${items[i].label}${reset}`
      : items[i].label;
    const desc = items[i].desc ? `  ${dim}${items[i].desc}${reset}` : '';
    lines.push(`  ${pointer} ${label}${desc}`);
  }

  lines.push('');
  return lines;
}

async function mainMenu() {
  const sessions = getStuckSessions();
  const backups = getBackups();

  const totalFiles = sessions.reduce((sum, s) => sum + s.unresolvedCount, 0);
  const sessionDesc = sessions.length > 0
    ? `${sessions.length} session${sessions.length !== 1 ? 's' : ''}, ${totalFiles} files to review`
    : 'none found';

  const menuItems = [
    { id: 'clear', label: 'clear stuck reviews', desc: sessionDesc },
    { id: 'restore', label: 'restore backup', desc: `${backups.length} backup${backups.length !== 1 ? 's' : ''} available` },
    { id: 'quit', label: 'quit', desc: '' },
  ];

  let cursor = 0;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdout.write('\x1b[?25l');

  let lastLineCount = 0;

  function draw() {
    if (lastLineCount > 0) {
      process.stdout.write(`\x1b[${lastLineCount}A`);
      process.stdout.write('\x1b[0J');
    }
    const lines = renderMenu(menuItems, cursor);
    process.stdout.write(lines.join('\n') + '\n');
    lastLineCount = lines.length;
  }

  function cleanup() {
    process.stdout.write('\x1b[?25h');
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  draw();

  return new Promise((resolve) => {
    process.stdin.on('data', (key) => {
      if (key === '\x03' || key === 'q') {
        cleanup();
        process.exit(0);
      }

      if (key === '\r' || key === '\n') {
        cleanup();
        resolve(menuItems[cursor].id);
        return;
      }

      if (key === '\x1b[A' || key === 'k') {
        cursor = Math.max(0, cursor - 1);
        draw();
        return;
      }
      if (key === '\x1b[B' || key === 'j') {
        cursor = Math.min(menuItems.length - 1, cursor + 1);
        draw();
        return;
      }
    });
  });
}

// ============================================================================
// Flows
// ============================================================================

async function clearFlow() {
  const sessions = getStuckSessions();

  if (sessions.length === 0) {
    console.log(`\n  ${green}no stuck review sessions found${reset}\n`);
    return;
  }

  const totalFiles = sessions.reduce((sum, s) => sum + s.unresolvedCount, 0);
  const CLEAR_ALL = {
    id: '__clear_all__',
    unresolvedCount: totalFiles,
    totalEntries: sessions.reduce((sum, s) => sum + s.totalEntries, 0),
    sampleFile: '',
    mtime: 0,
    isClearAll: true,
    label: `clear all (${sessions.length} sessions, ${totalFiles} files)`,
  };

  const items = [CLEAR_ALL, ...sessions];

  const selectedItems = await interactiveSelect(
    'stuck review cleaner',
    '(↑↓ navigate, space select, enter clear, q quit)',
    items,
    (s, isActive) => {
      if (s.isClearAll) {
        return isActive
          ? `${bold}${red}${s.label}${reset}`
          : `${red}${s.label}${reset}`;
      }
      const idShort = s.id.slice(0, 8);
      const nameStr = isActive
        ? `${bold}${white}${idShort}${reset}`
        : idShort;
      const fileLabel = `${yellow}${s.unresolvedCount}${reset} ${dim}file${s.unresolvedCount !== 1 ? 's' : ''} to review${reset}`;
      const sample = s.sampleFile ? ` ${dim}(${s.sampleFile}, ...)${reset}` : '';
      const ago = s.mtime ? `  ${dim}${timeAgo(s.mtime)}${reset}` : '';
      return `${nameStr}  ${fileLabel}${sample}${ago}`;
    },
  );

  if (selectedItems.length === 0) {
    console.log(`\n  ${yellow}nothing selected${reset}\n`);
    return;
  }

  const toClear = selectedItems.some((s) => s.isClearAll)
    ? sessions
    : selectedItems;

  await ensureCursorClosed();

  const backupPath = createBackup(toClear);
  console.log(`  ${dim}backed up ${toClear.length} session(s) to ${basename(backupPath)}${reset}`);

  for (const s of toClear) {
    clearSession(s.id);
  }
  clearComposerDbState();

  const clearedFiles = toClear.reduce((sum, s) => sum + s.unresolvedCount, 0);
  console.log('');
  console.log(
    `  ${green}cleared ${toClear.length} session${toClear.length !== 1 ? 's' : ''} (${clearedFiles} files).${reset}`,
  );
  await offerRelaunchCursor();
}

async function restoreFlow() {
  const backups = getBackups();

  if (backups.length === 0) {
    console.log(`\n  ${yellow}no backups found${reset}\n`);
    return;
  }

  const selectedBackups = await interactiveSelect(
    'restore backup',
    '(↑↓ navigate, space select, enter restore, q quit)',
    backups,
    (b, isActive) => {
      const nameStr = isActive
        ? `${bold}${white}${formatTimestamp(b.timestamp)}${reset}`
        : formatTimestamp(b.timestamp);
      const size = `${dim}${formatBytes(b.size)}${reset}`;
      const ago = `${dim}${timeAgo(b.mtime)}${reset}`;
      return `${nameStr}  ${size}  ${ago}`;
    },
  );

  if (selectedBackups.length === 0) {
    console.log(`\n  ${yellow}nothing selected${reset}\n`);
    return;
  }

  if (selectedBackups.length > 1) {
    console.log(`\n  ${yellow}select only one backup to restore${reset}\n`);
    return;
  }

  const backup = selectedBackups[0];

  await ensureCursorClosed();

  restoreBackup(backup.path);

  console.log('');
  console.log(
    `  ${green}restored from ${formatTimestamp(backup.timestamp)}.${reset}`,
  );
  await offerRelaunchCursor();
}

// ============================================================================
// Entry
// ============================================================================

if (!existsSync(SESSIONS_DIR)) {
  console.log(`\n  ${red}chatEditingSessions directory not found${reset}\n`);
  process.exit(1);
}

const action = await mainMenu();

if (action === 'clear') await clearFlow();
else if (action === 'restore') await restoreFlow();
