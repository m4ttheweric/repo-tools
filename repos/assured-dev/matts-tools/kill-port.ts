#!/usr/bin/env bun

import { execSync } from 'child_process';

const esc = (code: number): string => `\x1b[${code}m`;
const reset = esc(0);
const bold = esc(1);
const dim = esc(2);
const red = esc(31);
const green = esc(32);
const yellow = esc(33);
const cyan = esc(36);
const white = esc(37);

interface ProcessInfo {
  command: string;
  pid: string;
  user: string;
  port: number;
  type: string;
  name: string;
}

function parsePortInput(input: string): number[] | null {
  const rangeMatch = input.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const lo = Number(rangeMatch[1]);
    const hi = Number(rangeMatch[2]);
    if (lo > hi || hi - lo > 100) return null;
    const ports: number[] = [];
    for (let p = lo; p <= hi; p++) ports.push(p);
    return ports;
  }
  if (/^\d+$/.test(input)) return [Number(input)];
  return null;
}

function getProcessesOnPort(port: number): ProcessInfo[] {
  try {
    const raw = execSync(`lsof -i:${port} -P -n 2>/dev/null`, {
      encoding: 'utf8',
    });
    const lines = raw.trim().split('\n');
    if (lines.length <= 1) return [];
    return lines.slice(1).map((line) => {
      const parts = line.split(/\s+/);
      return {
        command: parts[0],
        pid: parts[1],
        user: parts[2],
        port,
        type: parts[7] || '',
        name: parts[8] || '',
      };
    });
  } catch {
    return [];
  }
}

function getProcessesForInput(input: string): ProcessInfo[] | null {
  const ports = parsePortInput(input);
  if (!ports) return null;
  const all: ProcessInfo[] = [];
  for (const p of ports) all.push(...getProcessesOnPort(p));
  return all;
}

function killProcesses(pids: string[]): number {
  const unique = [...new Set(pids)];
  for (const pid of unique) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      // already dead
    }
  }
  return unique.length;
}

function render(
  input: string,
  processes: ProcessInfo[] | null,
  statusMsg: string | null,
): string[] {
  const lines: string[] = [];
  const isRange = input.includes('-') && parsePortInput(input);
  const label = isRange ? 'port range' : 'port';

  lines.push('');
  lines.push(
    `  ${bold}${cyan}kill port${reset}  ${dim}(type port or range e.g. 3000-3010, enter to kill, q to quit)${reset}`,
  );
  lines.push('');

  if (statusMsg) {
    lines.push(`  ${statusMsg}`);
    lines.push('');
  }

  lines.push(`  ${yellow}${label}:${reset} ${input}${dim}▏${reset}`);
  lines.push('');

  const valid = input.length > 0 && parsePortInput(input);

  if (input.length === 0) {
    lines.push(`  ${dim}waiting for port number...${reset}`);
  } else if (!valid) {
    lines.push(
      `  ${red}invalid input${reset}  ${dim}use a port (3000) or range (3000-3010, max 100)${reset}`,
    );
  } else if (processes === null) {
    lines.push(`  ${dim}scanning...${reset}`);
  } else if (processes.length === 0) {
    lines.push(`  ${dim}nothing running on ${input}${reset}`);
  } else {
    const pids = [...new Set(processes.map((p) => p.pid))];
    const ports = [...new Set(processes.map((p) => p.port))];
    const portLabel =
      ports.length > 1 ? `${ports.length} ports` : `port ${ports[0]}`;
    lines.push(
      `  ${bold}${white}${pids.length} process${pids.length !== 1 ? 'es' : ''} on ${portLabel}:${reset}`,
    );
    lines.push('');

    const seen = new Set<string>();
    for (const proc of processes) {
      if (seen.has(proc.pid)) continue;
      seen.add(proc.pid);
      const portTag =
        ports.length > 1 ? `  ${dim}:${proc.port}${reset}` : '';
      lines.push(
        `  ${red}●${reset} ${bold}${proc.command}${reset}  ${dim}pid ${proc.pid}  ${proc.user}${reset}${portTag}`,
      );
    }

    lines.push('');
    lines.push(`  ${dim}press enter to kill, q to cancel${reset}`);
  }

  lines.push('');
  return lines;
}

async function run(): Promise<void> {
  let port = '';
  let processes: ProcessInfo[] | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastLineCount = 0;
  let statusMsg: string | null = null;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdout.write('\x1b[?25l');

  function draw(): void {
    if (lastLineCount > 0) {
      process.stdout.write(`\x1b[${lastLineCount}A`);
      process.stdout.write('\x1b[0J');
    }
    const lines = render(port, processes, statusMsg);
    process.stdout.write(lines.join('\n') + '\n');
    lastLineCount = lines.length;
  }

  function cleanup(): void {
    process.stdout.write('\x1b[?25h');
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  function scanPort(): void {
    if (port.length > 0 && parsePortInput(port)) {
      processes = getProcessesForInput(port);
    } else {
      processes = null;
    }
    draw();
  }

  function scheduleScan(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    processes = null;
    draw();
    debounceTimer = setTimeout(scanPort, 150);
  }

  draw();

  process.stdin.on('data', (key: string) => {
    if (key === '\x03' || key === 'q') {
      cleanup();
      console.log(`\n  ${dim}cancelled${reset}\n`);
      process.exit(0);
    }

    if (key === '\r' || key === '\n') {
      if (!processes || processes.length === 0) return;
      const pids = [...new Set(processes.map((p) => p.pid))];
      killProcesses(pids);
      statusMsg = `${green}${bold}killed ${pids.length} process${pids.length !== 1 ? 'es' : ''} on ${port}${reset}`;
      port = '';
      processes = null;
      draw();
      return;
    }

    if (key === '\x7f') {
      statusMsg = null;
      port = port.slice(0, -1);
      scheduleScan();
      return;
    }

    if (key === '-' && port.length > 0 && !port.includes('-')) {
      statusMsg = null;
      port += key;
      draw();
      return;
    }

    if (key.length === 1 && key >= '0' && key <= '9') {
      statusMsg = null;
      port += key;
      scheduleScan();
      return;
    }
  });
}

await run();
