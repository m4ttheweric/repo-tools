#!/usr/bin/env python3
"""Spawn -> first paint for `rt-ui prompt` on a 120x40 pty. Run after
`bun run ui:build`. Reports min/median over N runs."""
import fcntl, os, pty, select, struct, subprocess, sys, termios, time

BIN = sys.argv[1] if len(sys.argv) > 1 else "ui/dist/rt-ui"
RUNS = int(sys.argv[2]) if len(sys.argv) > 2 else 10
SPEC = '{"t":"prompt","protocol":1,"kind":"select","title":"Access duration","options":[{"value":"1h","label":"1 hour"},{"value":"4h","label":"4 hours"}]}\n'

def answer_queries(master, chunk):
    if b"\x1b]11;?" in chunk:
        os.write(master, b"\x1b]11;rgb:1616/1212/2424\x1b\\")
    if b"\x1b[6n" in chunk:
        os.write(master, b"\x1b[1;1R")

def run_once():
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    err_r, err_w = os.pipe()
    env = dict(os.environ, RT_UI_BENCH="1", TERM="xterm-256color", COLORTERM="truecolor")
    t0 = time.monotonic_ns()
    # New session with the pty slave as its controlling terminal: /dev/tty
    # resolves to it while fds 0/1/2 stay our pipes (same shape as the Go
    # test harness).
    def make_ctty():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    proc = subprocess.Popen([BIN, "prompt"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err_w,
                            env=env, close_fds=True, pass_fds=(slave,), preexec_fn=make_ctty)
    os.close(slave); os.close(err_w)
    proc.stdin.write(SPEC.encode()); proc.stdin.flush()
    first = None; errbuf = b""; deadline = time.monotonic() + 10
    while first is None and time.monotonic() < deadline:
        r, _, _ = select.select([master, err_r], [], [], 0.05)
        if master in r:
            try:
                chunk = os.read(master, 65536); answer_queries(master, chunk)
            except OSError:
                break
        if err_r in r:
            chunk = os.read(err_r, 4096)
            if not chunk: break
            errbuf += chunk
            if b"first-paint" in errbuf:
                first = (time.monotonic_ns() - t0) / 1e6
    os.write(master, b"\r")
    try: proc.wait(timeout=3)
    except subprocess.TimeoutExpired: proc.kill()
    for fd in (master, err_r):
        try: os.close(fd)
        except OSError: pass
    return first

samples = [s for s in (run_once() for _ in range(RUNS)) if s is not None]
if not samples:
    print("no first-paint observed; is the pty the controlling tty? (see the preexec/ctty note in the plan)"); sys.exit(1)
samples.sort()
print(f"rt-ui prompt first-paint ms: min={samples[0]:.0f} median={samples[len(samples)//2]:.0f} max={samples[-1]:.0f} (n={len(samples)})")
