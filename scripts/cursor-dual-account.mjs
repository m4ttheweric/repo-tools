#!/usr/bin/env node
/**
 * Cursor Dual-Account Setup (macOS) — interactive TUI
 *
 * Run two Cursor instances with separate accounts (work + personal).
 *
 * Layout:
 *  /Applications/Cursor.app           — work (untouched)
 *  /Applications/Cursor Personal.app  — personal (launcher with distinct icon)
 *  ~/.cursor-personal/Cursor.app      — hidden binary copy
 *  ~/.cursor-personal/user-data/      — isolated settings & state
 *  ~/.cursor-personal/extensions/     — isolated extensions
 *
 * Actions:
 *  Setup    — first-time install (duplicate, build launcher, apply icon)
 *  Update   — after Cursor auto-updates (re-sync copy, rebuild launcher, reapply icon)
 *  Icon     — regenerate the alternate icon only
 *
 * Controls:
 *  ↑↓ / j k  navigate    space  toggle    enter  run
 *  d  dry-run toggle      x  quit Cursor first    q  quit
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, mkdtempSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- ANSI ----------
const esc = (c) => `\x1b[${c}m`;
const reset = esc(0);
const bold = esc(1);
const dim = esc(2);
const cyan = esc(36);
const green = esc(32);
const yellow = esc(33);
const red = esc(31);
const magenta = esc(35);
const white = esc(37);

const CHECKBOX_ON = `${green}◉${reset}`;
const CHECKBOX_OFF = `${dim}○${reset}`;
const POINTER = `${cyan}❯${reset}`;
const BLANK = ' ';
const DOT_OK = `${green}●${reset}`;
const DOT_MISS = `${red}●${reset}`;
const DOT_STALE = `${yellow}●${reset}`;

// ---------- Defaults ----------
const HOME = process.env.HOME ?? '';
const BASE_DIR = join(HOME, '.cursor-personal');
const DEFAULTS = {
  workApp: '/Applications/Cursor.app',
  hiddenApp: join(BASE_DIR, 'Cursor.app'),
  launcherApp: '/Applications/Cursor Personal.app',
  baseDir: BASE_DIR,
};

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function runCmd(cmd, { dryRun = false, stdio = 'pipe' } = {}) {
  if (dryRun) return { ok: true, stdout: '', stderr: '' };
  try {
    const out = execSync(cmd, { stdio, shell: true });
    return { ok: true, stdout: out?.toString?.() ?? '', stderr: '' };
  } catch (e) {
    return {
      ok: false,
      stdout: e?.stdout?.toString?.() ?? '',
      stderr: e?.stderr?.toString?.() ?? String(e),
    };
  }
}

function checkCmdExists(cmd) {
  const r = spawnSync('command', ['-v', cmd], { shell: true, stdio: 'ignore' });
  return r.status === 0;
}

function cursorBinaryPath(appPath) {
  return join(appPath, 'Contents', 'MacOS', 'Cursor');
}

function getDuKB(path) {
  const r = runCmd(`du -sk ${shQuote(path)} | awk '{print $1}'`, { dryRun: false, stdio: 'pipe' });
  if (!r.ok) return null;
  const n = Number(String(r.stdout).trim());
  return Number.isFinite(n) ? n : null;
}

function getDfFreeKB(path) {
  const r = runCmd(`df -k ${shQuote(path)} | tail -1 | awk '{print $4}'`, { dryRun: false, stdio: 'pipe' });
  if (!r.ok) return null;
  const n = Number(String(r.stdout).trim());
  return Number.isFinite(n) ? n : null;
}

function humanBytesFromKB(kb) {
  if (!Number.isFinite(kb)) return 'unknown';
  if (kb >= 1048576) return `${(kb / 1048576).toFixed(1)} GB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${kb} KB`;
}

function getAppVersion(appPath) {
  const plist = join(appPath, 'Contents', 'Info.plist');
  if (!existsSync(plist)) return null;
  const r = runCmd(`/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" ${shQuote(plist)}`, { stdio: 'pipe' });
  return r.ok ? r.stdout.trim() || null : null;
}

function getModTime(path) {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

function timeAgo(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function elapsed(startMs) {
  const sec = ((Date.now() - startMs) / 1000).toFixed(1);
  return `${sec}s`;
}

// ---------- State Detection ----------
function detectState(state) {
  const info = {
    workExists: existsSync(state.workApp),
    workVersion: getAppVersion(state.workApp),
    hiddenExists: existsSync(state.hiddenApp),
    hiddenVersion: getAppVersion(state.hiddenApp),
    hiddenModTime: getModTime(state.hiddenApp),
    launcherExists: existsSync(state.launcherApp),
    dataDirExists: existsSync(join(state.baseDir, 'user-data')),
    oldLauncherExists: existsSync('/Applications/Cursor Personal Launcher.app'),
    hiddenStale: false,
  };

  if (info.workExists && info.hiddenExists) {
    const workMod = getModTime(join(state.workApp, 'Contents', 'MacOS', 'Cursor'));
    const hiddenMod = getModTime(join(state.hiddenApp, 'Contents', 'MacOS', 'Cursor'));
    if (workMod && hiddenMod && workMod > hiddenMod + 60000) {
      info.hiddenStale = true;
    }
    if (info.workVersion && info.hiddenVersion && info.workVersion !== info.hiddenVersion) {
      info.hiddenStale = true;
    }
  }

  return info;
}

// ---------- Validation ----------
function validateAssumptions(state) {
  const errors = [];
  const warnings = [];

  if (process.platform !== 'darwin') {
    errors.push(`This script is for macOS (darwin). Detected: ${process.platform}`);
  }

  const required = ['osascript', 'osacompile', 'ditto', 'du', 'df', 'sips'];
  for (const c of required) {
    if (!checkCmdExists(c)) errors.push(`Missing required command: ${c}`);
  }

  if (!existsSync(state.workApp)) errors.push(`Work app not found: ${state.workApp}`);
  else {
    const bin = cursorBinaryPath(state.workApp);
    if (!existsSync(bin)) errors.push(`Work Cursor binary not found: ${bin}`);
  }

  if (existsSync(state.workApp)) {
    const workKB = getDuKB(state.workApp);
    const freeKB = getDfFreeKB(HOME);
    if (workKB != null && freeKB != null) {
      if (freeKB < Math.ceil(workKB * 1.2)) {
        warnings.push(
          `Free space may be tight. Cursor.app ~${humanBytesFromKB(workKB)}, free ~${humanBytesFromKB(freeKB)}.`
        );
      }
    }
  }

  return { errors, warnings };
}

// ---------- Actions ----------
function actionQuitCursor({ dryRun }) {
  const cmd = `osascript -e 'tell application "Cursor" to quit' >/dev/null 2>&1 || true`;
  const r = runCmd(cmd, { dryRun, stdio: 'pipe' });
  return r.ok ? null : `Failed to quit Cursor: ${r.stderr || r.stdout}`;
}

function actionEnsureDirs({ baseDir, dryRun }) {
  const userData = join(baseDir, 'user-data');
  const extDir = join(baseDir, 'extensions');
  if (dryRun) return null;
  try {
    mkdirSync(userData, { recursive: true });
    mkdirSync(extDir, { recursive: true });
    return null;
  } catch (e) {
    return `Failed to create dirs under ${baseDir}: ${String(e)}`;
  }
}

function actionDuplicateApp({ workApp, hiddenApp, dryRun, force = false }) {
  if (dryRun) return null;
  if (existsSync(hiddenApp) && !force) {
    return `Refusing to overwrite existing: ${hiddenApp} (use Rededupe action)`;
  }
  if (existsSync(hiddenApp) && force) {
    try { rmSync(hiddenApp, { recursive: true, force: true }); } catch {}
  }
  const r = runCmd(`ditto ${shQuote(workApp)} ${shQuote(hiddenApp)}`, { dryRun: false, stdio: 'pipe' });
  if (!r.ok) return `ditto failed: ${r.stderr || r.stdout}`;
  const bin = cursorBinaryPath(hiddenApp);
  if (!existsSync(bin)) return `Cursor binary missing after copy: ${bin}`;
  return null;
}

function actionBuildLauncher({ launcherApp, hiddenApp, baseDir, dryRun }) {
  const hiddenBin = cursorBinaryPath(hiddenApp);
  if (!existsSync(hiddenBin) && !dryRun) {
    return `Cursor binary not found (did you duplicate?): ${hiddenBin}`;
  }

  const userData = join(baseDir, 'user-data');
  const extDir = join(baseDir, 'extensions');

  const appleScript = `do shell script ${JSON.stringify(
    `${hiddenBin} --user-data-dir=${userData} --extensions-dir=${extDir} >/dev/null 2>&1 &`
  )}`;

  if (dryRun) return null;

  try {
    if (existsSync(launcherApp)) rmSync(launcherApp, { recursive: true, force: true });

    const td = mkdtempSync(join(tmpdir(), 'cursor-launcher-'));
    const scriptPath = join(td, 'launcher.applescript');
    writeFileSync(scriptPath, appleScript, 'utf8');

    const r = runCmd(`osacompile -o ${shQuote(launcherApp)} ${shQuote(scriptPath)}`, { dryRun: false, stdio: 'pipe' });
    if (!r.ok) return `osacompile failed: ${r.stderr || r.stdout}`;
    if (!existsSync(launcherApp)) return `Launcher app not created: ${launcherApp}`;

    rmSync(td, { recursive: true, force: true });
    return null;
  } catch (e) {
    return `Failed to build launcher: ${String(e)}`;
  }
}

/**
 * Generate an alternate icon for the personal launcher:
 *  - Extract Cursor's Cursor.icns as a 1024 PNG
 *  - Per-pixel remap: dark background becomes a bright pink→violet→blue→cyan gradient,
 *    bright prism geometry is preserved and boosted
 *  - Apply via NSWorkspace.setIcon for immediate Finder/Dock update
 */
function actionApplyDynamicLauncherIcon({ workApp, launcherApp, dryRun }) {
  const sourceIcns = join(workApp, 'Contents', 'Resources', 'Cursor.icns');
  if (!existsSync(sourceIcns)) {
    return `Could not find Cursor icon at: ${sourceIcns}`;
  }
  if (!existsSync(launcherApp)) {
    return `Launcher app not found (build it first): ${launcherApp}`;
  }

  if (dryRun) return null;

  try {
    const td = mkdtempSync(join(tmpdir(), 'cursor-icon-'));

    const basePng = join(td, 'base-1024.png');
    const badgedPng = join(td, 'badged-1024.png');

    // 1) Convert icns -> 1024x1024 png
    {
      const r1 = runCmd(`sips -s format png ${shQuote(sourceIcns)} --out ${shQuote(basePng)}`, {
        dryRun: false,
        stdio: 'pipe',
      });
      if (!r1.ok) return `sips icns->png failed: ${r1.stderr || r1.stdout}`;

      const r2 = runCmd(`sips -z 1024 1024 ${shQuote(basePng)} --out ${shQuote(basePng)}`, {
        dryRun: false,
        stdio: 'pipe',
      });
      if (!r2.ok) return `sips resize failed: ${r2.stderr || r2.stdout}`;
    }

    // 2) Generate tinted variant
    const tintScript = join(__dirname, 'tint-icon.swift');
    const setIconScript = join(__dirname, 'set-app-icon.swift');
    {
      const r = runCmd(`swift ${shQuote(tintScript)} ${shQuote(basePng)} ${shQuote(badgedPng)}`, { dryRun: false, stdio: 'pipe' });
      if (!r.ok) return `Tint script failed: ${r.stderr || r.stdout}`;
      if (!existsSync(badgedPng)) return `Tinted icon not created: ${badgedPng}`;
    }

    // 3) Apply icon via NSWorkspace.setIcon (modern macOS ignores applet.icns)
    {
      const r = runCmd(
        `swift ${shQuote(setIconScript)} ${shQuote(badgedPng)} ${shQuote(launcherApp)}`,
        { dryRun: false, stdio: 'pipe' }
      );
      if (!r.ok) return `Failed to set app icon: ${r.stderr || r.stdout}`;
    }

    // Cleanup
    rmSync(td, { recursive: true, force: true });
    return null;
  } catch (e) {
    return `Failed to generate/apply dynamic icon: ${String(e)}`;
  }
}

function actionCleanupOldApps({ dryRun }) {
  const oldLauncher = '/Applications/Cursor Personal Launcher.app';
  const removed = [];

  if (existsSync(oldLauncher)) {
    if (!dryRun) {
      try { rmSync(oldLauncher, { recursive: true, force: true }); } catch {}
    }
    removed.push(oldLauncher);
  }

  return removed;
}

// ---------- UI ----------
function render(state, cursorIdx, items, messages, info, pendingConfirm) {
  const lines = [];

  lines.push('');
  lines.push(`  ${bold}${cyan}cursor dual-account setup${reset}`);
  lines.push(`  ${dim}↑↓/jk move  space toggle  enter run  d dry-run  x quit-first  q quit${reset}`);
  lines.push('');

  // Component status dashboard
  lines.push(`  ${bold}${magenta}status${reset}`);

  const workDot = info.workExists ? DOT_OK : DOT_MISS;
  const workVer = info.workVersion ? ` ${dim}v${info.workVersion}${reset}` : '';
  lines.push(`  ${workDot} ${white}Cursor.app${reset}${workVer}  ${dim}/Applications${reset}`);

  const hiddenDot = info.hiddenExists ? (info.hiddenStale ? DOT_STALE : DOT_OK) : DOT_MISS;
  const hiddenVer = info.hiddenVersion ? ` ${dim}v${info.hiddenVersion}${reset}` : '';
  const hiddenAge = info.hiddenModTime ? ` ${dim}(${timeAgo(info.hiddenModTime)})${reset}` : '';
  const hiddenNote = info.hiddenStale ? `  ${yellow}update available${reset}` : '';
  lines.push(`  ${hiddenDot} ${white}Hidden copy${reset}${hiddenVer}${hiddenAge}${hiddenNote}  ${dim}~/.cursor-personal${reset}`);

  const launcherDot = info.launcherExists ? DOT_OK : DOT_MISS;
  lines.push(`  ${launcherDot} ${white}Cursor Personal.app${reset}  ${dim}/Applications${reset}`);

  const dataDot = info.dataDirExists ? DOT_OK : DOT_MISS;
  lines.push(`  ${dataDot} ${white}User data${reset}  ${dim}~/.cursor-personal/user-data${reset}`);

  if (info.oldLauncherExists) {
    lines.push(`  ${DOT_STALE} ${yellow}Old launcher found${reset}  ${dim}/Applications/Cursor Personal Launcher.app${reset}`);
  }

  lines.push('');
  lines.push(`  ${dim}${green}●${reset}${dim} ready  ${yellow}●${reset}${dim} stale  ${red}●${reset}${dim} missing${reset}`);
  lines.push('');

  // Options
  lines.push(`  ${bold}${magenta}options${reset}`);
  lines.push(`  ${dim}dry run:${reset} ${state.dryRun ? `${green}ON${reset}` : `${yellow}OFF${reset}`}  ${dim}(d)${reset}    ${dim}quit cursor first:${reset} ${state.quitFirst ? `${green}YES${reset}` : `${yellow}NO${reset}`}  ${dim}(x)${reset}`);
  lines.push('');

  // Actions
  lines.push(`  ${bold}${magenta}actions${reset}`);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const isActive = i === cursorIdx;
    const pointer = isActive ? POINTER : BLANK;
    const box = it.enabled ? CHECKBOX_ON : CHECKBOX_OFF;
    const label = isActive ? `${bold}${white}${it.label}${reset}` : `${white}${it.label}${reset}`;
    const hint = it.hint ? `  ${dim}${it.hint}${reset}` : '';
    lines.push(`  ${pointer} ${box} ${label}${hint}`);
  }

  lines.push('');

  // Pending confirmation
  if (pendingConfirm) {
    lines.push(`  ${bold}${yellow}Press enter again to confirm (this will make changes)${reset}`);
    lines.push('');
  }

  // Status messages
  if (messages.length) {
    lines.push(`  ${bold}${magenta}log${reset}`);
    for (const m of messages.slice(-10)) lines.push(m);
    lines.push('');
  }

  lines.push(`  ${dim}tip:${reset} drag ${white}Cursor Personal.app${reset} into the Dock for a second Cursor icon`);
  lines.push('');

  return lines;
}

async function runInteractive() {
  const state = {
    ...DEFAULTS,
    dryRun: true,
    quitFirst: true,
  };

  let info = detectState(state);

  const items = [
    {
      key: 'setup',
      label: 'Setup',
      hint: 'first-time install — create dirs, duplicate app, build launcher, apply icon',
      enabled: !info.launcherExists,
    },
    {
      key: 'update',
      label: 'Update',
      hint: 'after Cursor auto-updates — re-sync hidden copy, rebuild launcher, reapply icon',
      enabled: info.hiddenStale,
    },
    {
      key: 'icon',
      label: 'Reapply icon',
      hint: 'regenerate the alternate icon only',
      enabled: false,
    },
  ];

  let cursorIdx = 0;
  let lastLineCount = 0;
  const messages = [];
  let pendingConfirm = false;

  function draw() {
    if (lastLineCount > 0) {
      process.stdout.write(`\x1b[${lastLineCount}A`);
      process.stdout.write('\x1b[0J');
    }
    const lines = render(state, cursorIdx, items, messages, info, pendingConfirm);
    process.stdout.write(lines.join('\n') + '\n');
    lastLineCount = lines.length;
  }

  function cleanup() {
    process.stdout.write('\x1b[?25h');
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  function pushMsg(text, kind = 'info') {
    const prefix =
      kind === 'ok' ? `${green}✔${reset}` :
      kind === 'warn' ? `${yellow}⚠${reset}` :
      kind === 'err' ? `${red}✖${reset}` :
      `${dim}•${reset}`;
    messages.push(`  ${prefix} ${text}`);
  }

  function timedAction(label, fn) {
    const start = Date.now();
    draw();
    const result = fn();
    const dur = elapsed(start);
    return { result, dur };
  }

  function runPlan() {
    const { errors, warnings } = validateAssumptions(state);
    warnings.forEach((w) => pushMsg(w, 'warn'));
    if (errors.length) {
      errors.forEach((e) => pushMsg(e, 'err'));
      pushMsg('Fix errors above before running.', 'err');
      draw();
      return;
    }

    const selected = items.filter((i) => i.enabled).map((i) => i.key);
    if (selected.length === 0) {
      pushMsg('No actions selected.', 'warn');
      draw();
      return;
    }

    const dryRun = state.dryRun;
    const runStart = Date.now();
    pushMsg(`${dryRun ? 'Dry run' : 'Running'}: ${selected.join(', ')}`, 'ok');
    draw();

    if (state.quitFirst) {
      const err = actionQuitCursor({ dryRun });
      if (err) pushMsg(err, 'warn');
      else pushMsg('Cursor quit requested.', 'ok');
      draw();
    }

    const errDirs = actionEnsureDirs({ baseDir: state.baseDir, dryRun });
    if (errDirs) pushMsg(errDirs, 'err');
    else pushMsg('Data directories ensured.', 'ok');
    draw();

    // Auto-cleanup old layout artifacts
    const removed = actionCleanupOldApps({ dryRun });
    if (removed.length) {
      pushMsg(`Cleaned up old: ${removed.join(', ')}`, 'ok');
      draw();
    }

    // Setup: full first-time install
    if (selected.includes('setup')) {
      pushMsg('Duplicating Cursor.app...', 'info');
      draw();
      const { result: errDup, dur } = timedAction('duplicate', () =>
        actionDuplicateApp({ workApp: state.workApp, hiddenApp: state.hiddenApp, dryRun, force: true })
      );
      if (errDup) pushMsg(errDup, 'err');
      else pushMsg(`Hidden copy created (${dur})`, 'ok');
      draw();

      const errLaunch = actionBuildLauncher({
        launcherApp: state.launcherApp,
        hiddenApp: state.hiddenApp,
        baseDir: state.baseDir,
        dryRun,
      });
      if (errLaunch) pushMsg(errLaunch, 'err');
      else pushMsg('Launcher created.', 'ok');
      draw();
    }

    // Update: re-sync after Cursor auto-updates
    if (selected.includes('update')) {
      pushMsg('Syncing hidden copy with Cursor.app...', 'info');
      draw();
      const { result: errDup, dur } = timedAction('sync', () =>
        actionDuplicateApp({ workApp: state.workApp, hiddenApp: state.hiddenApp, dryRun, force: true })
      );
      if (errDup) pushMsg(errDup, 'err');
      else pushMsg(`Hidden copy synced (${dur})`, 'ok');
      draw();

      const errLaunch = actionBuildLauncher({
        launcherApp: state.launcherApp,
        hiddenApp: state.hiddenApp,
        baseDir: state.baseDir,
        dryRun,
      });
      if (errLaunch) pushMsg(errLaunch, 'err');
      else pushMsg('Launcher rebuilt.', 'ok');
      draw();
    }

    // Apply icon (runs for setup, update, or standalone icon action)
    if (selected.includes('setup') || selected.includes('update') || selected.includes('icon')) {
      pushMsg('Generating alternate icon...', 'info');
      draw();
      const { result: errIcon, dur } = timedAction('icon', () =>
        actionApplyDynamicLauncherIcon({
          workApp: state.workApp,
          launcherApp: state.launcherApp,
          dryRun,
        })
      );
      if (errIcon) pushMsg(errIcon, 'err');
      else pushMsg(`Alternate icon applied (${dur})`, 'ok');
      draw();
    }

    const totalDur = elapsed(runStart);
    if (dryRun) {
      pushMsg(`Dry run complete — no changes made (${totalDur})`, 'ok');
    } else {
      pushMsg(`Done in ${totalDur}! Drag "Cursor Personal" into the Dock.`, 'ok');
    }

    // Refresh state indicators
    info = detectState(state);
    draw();
  }

  // Preflight
  const { errors, warnings } = validateAssumptions(state);
  warnings.forEach((w) => pushMsg(w, 'warn'));
  errors.forEach((e) => pushMsg(e, 'err'));

  if (existsSync(state.workApp)) {
    const workKB = getDuKB(state.workApp);
    const freeKB = getDfFreeKB(HOME);
    if (workKB != null) pushMsg(`Cursor.app: ${humanBytesFromKB(workKB)}`, 'info');
    if (freeKB != null) pushMsg(`Free space: ${humanBytesFromKB(freeKB)}`, 'info');
  }

  if (!errors.length) pushMsg('Ready. Toggle dry-run OFF (d), then press enter.', 'ok');
  else pushMsg('Fix errors above before running.', 'err');

  // Init raw-mode UI
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdout.write('\x1b[?25l');

  let lastDraw = 0;
  function safeDraw() {
    const now = Date.now();
    if (now - lastDraw < 10) return;
    lastDraw = now;
    draw();
  }

  safeDraw();

  return new Promise((resolve) => {
    process.stdin.on('data', (key) => {
      if (key === '\x03' || key === 'q') {
        cleanup();
        console.log(`\n  ${dim}cancelled${reset}\n`);
        process.exit(0);
      }

      if (key === '\r' || key === '\n') {
        if (!state.dryRun && !pendingConfirm) {
          pendingConfirm = true;
          safeDraw();
          return;
        }
        pendingConfirm = false;
        runPlan();
        return;
      }

      // Any other key cancels pending confirmation
      if (pendingConfirm) {
        pendingConfirm = false;
      }

      if (key === ' ') {
        items[cursorIdx].enabled = !items[cursorIdx].enabled;
        safeDraw();
        return;
      }
      if (key === 'd') {
        state.dryRun = !state.dryRun;
        pendingConfirm = false;
        pushMsg(`dry run ${state.dryRun ? 'ON' : 'OFF'}`, 'ok');
        safeDraw();
        return;
      }
      if (key === 'x') {
        state.quitFirst = !state.quitFirst;
        pushMsg(`quit cursor first ${state.quitFirst ? 'YES' : 'NO'}`, 'ok');
        safeDraw();
        return;
      }

      if (key === '\x1b[A' || key === 'k') {
        cursorIdx = Math.max(0, cursorIdx - 1);
        safeDraw();
        return;
      }
      if (key === '\x1b[B' || key === 'j') {
        cursorIdx = Math.min(items.length - 1, cursorIdx + 1);
        safeDraw();
        return;
      }
    });

    process.on('exit', () => cleanup());
    resolve();
  });
}

await runInteractive();
