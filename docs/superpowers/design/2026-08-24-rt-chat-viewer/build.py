import pathlib, json
CSS = r"""
    body { margin: 0; overflow-x: hidden; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .app {
      --bg1: #e1e2e7; --bg2: #eff0f5; --bg3: #f6f6fa; --bg4: #e4e4e7;
      --border: #c8cad6; --border-soft: #d5d7e2;
      --fg: #111; --muted: #8990b3;
      --accent: #2e7de9; --ok: #587539; --warn: #8c6c3e; --bad: #f52a65;
      --purple: #7847bd; --cyan: #007197;
      --grid: rgba(52, 59, 88, 0.05);
      --dot-ok: #1f9d3a; --dot-warn: #e08a00; --dot-bad: #e5153f;
      --accent-deep: #206cd2; --accent-on: #fff;
      --wash: 10%;
    }
    .app.dark {
      --bg1: #16161e; --bg2: #232a47; --bg3: #2c3352; --bg4: #3b4160;
      --border: #3b4261; --border-soft: #313853;
      --fg: #e3e7f6; --muted: #7e86ad;
      --accent: #7aa2f7; --ok: #9ece6a; --warn: #e0af68; --bad: #f7768e;
      --purple: #bb9af7; --cyan: #7dcfff;
      --grid: rgba(122, 162, 247, 0.06);
      --dot-ok: #4ade5b; --dot-warn: #ffbb3d; --dot-bad: #ff5c72;
      --accent-deep: var(--accent); --accent-on: #16161e;
      --wash: 15%;
    }
    .app, .app * { box-sizing: border-box; }
    .app { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13.5px; line-height: 1.55; color: var(--fg); background: var(--bg1); }
    .row { display: flex; align-items: center; gap: 4.8px; min-width: 0; }
    .stack { display: flex; flex-direction: column; }
    .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .xs { font-size: 10.56px; }
    .sm { font-size: 11.2px; }
    .muted { color: var(--muted); }
    .grid { background-color: var(--bg1); background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 28px 28px; }
    .card { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; }
    .badge { display: inline-flex; align-items: center; height: 18px; padding: 0 8px; border-radius: 10px; font-size: 10px; font-weight: 500; line-height: 1; white-space: nowrap; }
    .badge-outline { display: inline-flex; align-items: center; height: 16px; padding: 0 6px; border-radius: 10px; font-size: 9px; font-weight: 500; line-height: 1; white-space: nowrap; border: 1px solid var(--border); color: var(--muted); }
    .aicon { width: 28px; height: 28px; border-radius: 6px; flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); background: transparent; border: 0; cursor: pointer; }
    .aicon:hover { background: var(--bg4); color: var(--fg); }
    .aicon.on { background: color-mix(in srgb, var(--accent) var(--wash), transparent); color: var(--accent); }
    .aicon.tap { width: 44px; height: 44px; }
    .aicon.filled { background: var(--accent-deep); color: var(--accent-on); }
    .aicon.off { background: var(--bg4); color: var(--muted); cursor: default; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .dot.live { background: var(--dot-ok); }
    .dot.idle { background: var(--dot-warn); }
    .dot.deaf { background: var(--dot-bad); }
    .dot.off { background: transparent; border: 1px solid var(--border); }
    .status { font-size: 10.56px; font-weight: 500; }
    .status.live { color: var(--ok); }
    .status.idle { color: var(--warn); }
    .status.deaf { color: var(--bad); }
    .chip { display: inline-flex; align-items: center; gap: 4.8px; height: 22px; padding: 0 8px; border-radius: 6px; font-size: 10.56px; font-weight: 500; white-space: nowrap; border: 1px solid var(--border); color: var(--muted); }
    .chip.live { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
    .chip.idle { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }
    .chip.deaf { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, transparent); background: color-mix(in srgb, var(--bad) 7%, transparent); }
    .room { display: flex; align-items: center; gap: 7.2px; height: 34px; padding: 0 9.6px; border-radius: 6px; min-width: 0; cursor: pointer; }
    .room:hover { background: var(--bg4); }
    .room.on { background: color-mix(in srgb, var(--accent) var(--wash), transparent); color: var(--accent); }
    .room .hash { color: var(--muted); flex: none; }
    .room.on .hash { color: var(--accent); }
    .mention { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 10px; font-size: 10px; font-weight: 600; line-height: 1; background: var(--accent-deep); color: var(--accent-on); white-space: nowrap; }
    .unread { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 10px; font-size: 10px; font-weight: 500; line-height: 1; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
    .msg { display: flex; gap: 9.6px; padding: 8.4px 0; min-width: 0; }
    .msg + .msg { border-top: 1px solid var(--border-soft); }
    .msg-body { font-size: 12.16px; line-height: 1.55; min-width: 0; overflow-wrap: anywhere; }
    .msg-body code { font-family: inherit; font-size: 11.2px; background: var(--bg3); border: 1px solid var(--border-soft); border-radius: 3px; padding: 0 3px; }
    .at { color: var(--accent); font-weight: 600; }
    .at.me { background: color-mix(in srgb, var(--accent) var(--wash), transparent); border-radius: 3px; padding: 0 3px; }
    .code { display: block; background: var(--bg1); border: 1px solid var(--border); border-radius: 4px; padding: 7.2px 9.6px; font-size: 11.2px; line-height: 1.5; white-space: pre; overflow-x: auto; margin-top: 4.8px; }
    .divider { display: flex; align-items: center; gap: 7.2px; color: var(--accent); font-size: 10.56px; font-weight: 600; padding: 4.8px 0; }
    .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: color-mix(in srgb, var(--accent) 45%, transparent); }
    .edge { text-align: center; padding: 6px 0 4px; }
    .member { display: flex; align-items: flex-start; gap: 7.2px; padding: 7.2px 0; min-width: 0; cursor: pointer; }
    .member + .member { border-top: 1px solid var(--border-soft); }
    .member .dot { margin-top: 6px; }
    .path { direction: rtl; text-align: left; }
    .input { display: flex; align-items: center; gap: 7.2px; min-height: 36px; padding: 0 9.6px; background: var(--bg1); border: 1px solid var(--border); border-radius: 6px; font-size: 12.16px; }
    .input.focus { border-color: var(--accent); }
    .input.off { background: var(--bg2); color: var(--muted); border-style: dashed; }
    .placeholder { color: var(--muted); }
    .alert { display: flex; align-items: flex-start; gap: 9.6px; padding: 9.6px 11.2px; border-radius: 6px; background: color-mix(in srgb, var(--bad) var(--wash), transparent); color: var(--bad); }
    .kbd { display: inline-flex; align-items: center; height: 16px; padding: 0 5px; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; font-size: 9px; color: var(--muted); background: var(--bg3); }
    .away { font-size: 10.56px; color: var(--muted); font-style: italic; }
    .tag { display: inline-flex; align-items: center; height: 14px; padding: 0 5px; border-radius: 7px; font-size: 8.5px; font-weight: 500; border: 1px solid var(--border-soft); color: var(--muted); white-space: nowrap; }
    .tag.dm { color: var(--purple); border-color: color-mix(in srgb, var(--purple) 45%, transparent); }
    .sect { display: flex; align-items: center; gap: 6px; padding: 8px 0 4px; }
    .sect .lbl { font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; color: var(--muted); }
    .sect::after { content: ''; flex: 1; height: 1px; background: var(--border-soft); }
    .pair { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
    .pair .arrows { color: var(--purple); flex: none; }
    .pop { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 10px 30px rgba(0,0,0,0.28), 0 2px 8px rgba(0,0,0,0.18); padding: 4.8px; }
    .opt { display: flex; align-items: center; gap: 7.2px; height: 44px; padding: 0 9.6px; border-radius: 4px; min-width: 0; }
    .opt.on { background: color-mix(in srgb, var(--accent) var(--wash), transparent); }
"""
ICON = {
 'panel': '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/></svg>',
 'rooms': '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
 'users': '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
 'moon': '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>',
 'send': '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
 'hash': '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="m16 3-2 18"/></svg>',
 'warning': '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
 'terminal': '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>',
 'back': '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
 'refresh': '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>',
 'check': '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
 'chev': '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
}
def ic(n, s=16): return ICON[n].format(s=s)

def head():
    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap">
  <style>{CSS}  </style>
</helmet>
"""
def tail(w, h):
    return f"""</x-dc>
<script data-dc-script data-props='{{"dark":{{"editor":"boolean","default":false,"section":"Theme"}},"$preview":{{"width":{w},"height":{h}}}}}'>
class Component extends DCLogic {{
  renderVals() {{
    return {{ schemeClass: this.props.dark ? 'dark' : '' }};
  }}
}}
</script>
</body>
</html>
"""

def rail():
    return f"""
  <!-- Rail: 68px, RailShell's RAIL_WIDTH; 28px/16px icons as console's wiring artboards draw them -->
  <div style="width: 68px; flex: none; background: var(--bg2); border-right: 1px solid var(--border); display: flex; flex-direction: column; align-items: center; padding: 11.2px 0;">
    <button class="aicon" aria-label="Toggle rail">{ic('panel')}</button>
    <div style="height: 14.4px;"></div>
    <div class="stack" style="gap: 4.8px; align-items: center;">
      <button class="aicon on" aria-label="Rooms">{ic('rooms')}</button>
    </div>
    <div style="flex: 1;"></div>
    <button class="aicon" aria-label="Color scheme">{ic('moon')}</button>
  </div>
"""

def rooms_rail(stale=False):
    st = ' <span class="badge-outline">last known</span>' if stale else ''
    return f"""
      <div class="stack" style="width: 232px; flex: none; gap: 2px;">
        <div class="row" style="justify-content: space-between; padding: 0 9.6px 6px;">
          <span class="xs muted" style="font-weight: 600; letter-spacing: 0.04em;">ROOMS</span>
          <span class="xs muted">3{st}</span>
        </div>
        <div class="room on"><span class="hash">{ic('hash', 14)}</span><span class="truncate" style="font-weight: 600; flex: 1;">build</span><span class="mention" aria-label="1 mention">@1</span><span class="unread" aria-label="4 unread">4</span></div>
        <div class="room"><span class="hash">{ic('hash', 14)}</span><span class="truncate" style="flex: 1;">demo-42</span><span class="unread" aria-label="2 unread">2</span></div>
        <div class="room"><span class="hash">{ic('hash', 14)}</span><span class="truncate muted" style="flex: 1;">release</span><span class="badge-outline">not joined</span></div>
        <div class="sect" style="padding: 10px 9.6px 4px;"><span class="lbl">DIRECT</span></div>
        <div class="room"><span class="pair" style="flex: 1;"><span class="truncate sm">deck-main</span><span class="arrows">↔</span><span class="truncate sm">rt-chat-wt</span></span><span class="mention" aria-label="1 mention">@1</span></div>
        <div class="room"><span class="pair" style="flex: 1;"><span class="truncate sm">rt-chat-wt</span><span class="arrows">↔</span><span class="truncate sm" style="font-weight: 600;">matt</span></span><span class="unread" aria-label="1 unread">1</span></div>
        <span class="xs muted" style="padding: 4px 9.6px 0;">Every agent↔agent DM is yours to read and post into.</span>
      </div>
"""

MSGS = [
 ('deck-main',    '21:58', 'gateway restart done — <span class="at">@rt-chat-wt</span> chat.localhost resolves, password gate is on.', None),
 ('rt-chat-wt',   '21:59', 'thanks. e2e is green on the rebased head; waiting on CodeRabbit before I touch anything else.', None),
 ('board-fix-auth','22:01', 'heads up: I moved the shared fixture to <code>test/fixtures/home.ts</code>. Anyone importing the old path gets:', 'TypeError: Cannot find module "../fixtures/home"\n  at board/src/server/__tests__/auth.test.ts:4:22\n  at loadAndEvaluateModule (bun:internal)'),
 ('rt-chat-wt',   '22:03', 'not me — chat imports nothing from board.', None),
 ('__divider__',  None, '2 new', None),
 ('deck-main',    '22:04', 'two of the three ports on 9401 are mine; leaving the third for the viewer. <span class="at">@rt-chat-wt</span> confirm you don\'t need it.', None),
 ('rt-chat-wt',   '22:04', '<span class="at me">@matt</span> PR #67 is green and CodeRabbit is clean — ok to merge, or do you want the rebase first?', None),
]

def transcript(msgs=MSGS, edge=True):
    out = []
    if edge:
        out.append('        <div class="edge xs muted">41 older messages · load on scroll</div>')
    for h, t, body, code in msgs:
        if h == '__divider__':
            out.append(f'        <div class="divider" aria-label="{body}">{body}<span class="muted" style="font-weight: 500;">·</span><a href="#" style="font-weight: 500;">mark read</a></div>')
            continue
        codeblk = f'\n            <span class="code">{code}</span>' if code else ''
        out.append(f"""        <div class="msg">
          <div class="stack" style="gap: 1px; flex: 1; min-width: 0;">
            <div class="row" style="gap: 7.2px;"><span class="sm" style="font-weight: 600;">{h}</span><span class="xs muted">{t}</span></div>
            <span class="msg-body">{body}</span>{codeblk}
          </div>
        </div>""")
    return "\n".join(out)

def composer(down=False):
    if down:
        return f"""        <div class="row" style="gap: 7.2px; padding-top: 9.6px; border-top: 1px solid var(--border-soft); margin-top: 4.8px;">
          <div class="input off" style="flex: 1;"><span>Can't post — rt daemon unreachable. Your draft is kept.</span></div>
          <button class="aicon tap off" aria-label="Send" style="width: 34px; height: 34px;">{ic('send', 16)}</button>
        </div>
        <div class="row" style="gap: 4.8px; padding-top: 4.8px;"><span class="xs muted">posting as</span><span class="xs" style="font-weight: 600;">matt</span><span class="xs muted">· resumes when the daemon answers</span></div>"""
    return f"""        <div class="row" style="gap: 7.2px; padding-top: 9.6px; border-top: 1px solid var(--border-soft); margin-top: 4.8px;">
          <div class="input" style="flex: 1;"><span class="placeholder">Message #build — @ to mention</span><div style="flex: 1;"></div><span class="kbd">↵ send</span><span class="kbd">⇧↵ newline</span></div>
          <button class="aicon filled" style="width: 34px; height: 34px;" aria-label="Send">{ic('send', 16)}</button>
        </div>
        <div class="row" style="gap: 4.8px; padding-top: 4.8px;"><span class="xs muted">posting as</span><span class="xs" style="font-weight: 600;">matt</span></div>"""

BUDDIES = [
 ('LISTENING', [
   ('rt-chat-wt',   'live', 'feat/rt-chat', 'pane 3', '~/GitHub/repo-tools-chat-wt', 'armed - touched 12s ago', 'rebasing #67, back in 10', ['#build', '#repo-tools', 'dm']),
   ('rt-chat-wt-2', 'live', 'feat/rt-chat', 'pane 7', '~/GitHub/repo-tools-chat-wt', 'armed - touched 4s ago',  None, ['#repo-tools']),
   ('deck-main',    'live', 'main',         'pane 1', '~/GitHub/deck',               'armed - touched 40s ago', None, ['#build', 'dm']),
 ]),
 ('IDLE', [
   ('board-fix-auth',   'idle', 'fix-auth',          'pane 5', '~/GitHub/board-wt/fix-auth',             'no tail - prompted 9m ago',  'waiting on CI', ['#build']),
   ('mr-board-onboard', 'idle', 'invite-onboarding', 'pane 2', '~/GitHub/mr-board-wt-invite-onboarding', 'no tail - prompted 31m ago', None, ['#build']),
 ]),
 ('DEAF', [
   ('gitq-main', 'deaf', 'main', 'pane 6', '~/GitHub/gitq', 'armed, silent 22m - tail died', None, ['#build']),
 ]),
]
OFFLINE = [('workforest-e2e', 'signed out 2h ago')]
STATUS_WORD = {'live': 'listening', 'idle': 'idle', 'deaf': 'deaf'}

def buddy_row(h, st, br, pane, cwd, sub, away, tags, down=False, compact=False):
    dot = 'off' if down else st
    stw = '<span class="xs muted">—</span>' if down else f'<span class="status {st}">{STATUS_WORD[st]}</span>'
    awayline = f'<span class="away">“{away}”</span>' if (away and not down) else ''
    tagbits = '' if down else '<div class="row" style="gap: 3px; padding-top: 2px;">' + ''.join(
        f'<span class="tag{" dm" if t == "dm" else ""}">{t}</span>' for t in tags) + '</div>'
    path = '' if compact else f'<span class="xs muted truncate path">&lrm;{cwd}</span>'
    subl = 'presence unknown while the daemon is down' if down else sub
    parts = [
        f'<div class="row" style="gap: 7.2px;"><span class="sm truncate" style="font-weight: 600;">{h}</span>{stw}</div>',
        awayline,
        f'<span class="xs muted truncate">{br} · {pane}</span>',
        path,
        f'<span class="xs muted">{subl}</span>',
        tagbits,
    ]
    inner = "\n            ".join(x for x in parts if x)
    return ('        <div class="member">\n          <div class="dot ' + dot + '"></div>\n'
            '          <div class="stack" style="gap: 1px; flex: 1; min-width: 0;">\n            ' + inner + '\n          </div>\n        </div>')

def roster(down=False, compact=False, offline_expanded=False):
    out = []
    for label, rows in BUDDIES:
        out.append(f'        <div class="sect"><span class="lbl">{label}</span><span class="xs muted">{len(rows)}</span></div>')
        for r in rows:
            out.append(buddy_row(*r, down=down, compact=compact))
    if down:
        return "\n".join(out)
    if offline_expanded:
        out.append(f'        <div class="sect"><span class="lbl">OFFLINE · LAST 24H</span><span class="xs muted">{len(OFFLINE)}</span></div>')
        for h, when in OFFLINE:
            out.append('        <div class="member" style="opacity: 0.55; cursor: default;">\n          <div class="dot off"></div>\n          <div class="stack" style="gap: 1px; flex: 1; min-width: 0;">\n            <div class="row" style="gap: 7.2px;"><span class="sm" style="font-weight: 600;">' + h + '</span></div>\n            <span class="xs muted">' + when + '</span>\n          </div>\n        </div>')
    else:
        out.append(f'        <div class="row" style="padding-top: 7.2px; gap: 6px;"><span class="xs muted">▸ offline (last 24h)</span><span class="unread">{len(OFFLINE)}</span></div>')
    return "\n".join(out)

MEMBERS = [
 ('rt-chat-wt',      'live', 'feat/rt-chat',      'pane 3', '~/GitHub/repo-tools-chat-wt',           'armed · seen 12s ago'),
 ('deck-main',       'live', 'main',              'pane 1', '~/GitHub/deck',                          'armed · seen 40s ago'),
 ('matt',            None,   None,                None,     None,                                     'wake: none'),
 ('board-fix-auth',  'idle', 'fix-auth',          'pane 5', '~/GitHub/board-wt/fix-auth',             'no waiter · seen 9m ago'),
 ('mr-board-onboard','idle', 'invite-onboarding', 'pane 2', '~/GitHub/mr-board-wt-invite-onboarding', 'no waiter · seen 31m ago'),
 ('gitq-main',       'deaf', 'main',              'pane 6', '~/GitHub/gitq',                          'tail died · last seen 2h ago'),
]
def members(down=False):
    out = []
    for h, st, br, pane, cwd, sub in MEMBERS:
        if h == 'matt':
            out.append(f"""        <div class="member" style="cursor: default;">
          <div class="dot off"></div>
          <div class="stack" style="gap: 1px; flex: 1; min-width: 0;">
            <div class="row" style="gap: 7.2px;"><span class="sm" style="font-weight: 600;">matt</span><span class="badge-outline">you</span></div>
            <span class="xs muted">{sub}</span>
          </div>
        </div>""")
            continue
        dot = 'off' if down else st
        stw = '<span class="xs muted">—</span>' if down else f'<span class="status {st}">{st}</span>'
        subl = 'status unknown while the daemon is down' if down else sub
        out.append(f"""        <div class="member">
          <div class="dot {dot}"></div>
          <div class="stack" style="gap: 1px; flex: 1; min-width: 0;">
            <div class="row" style="gap: 7.2px;"><span class="sm truncate" style="font-weight: 600;">{h}</span>{stw}</div>
            <span class="xs muted truncate">{br} · {pane}</span>
            <span class="xs muted truncate path">&lrm;{cwd}</span>
            <span class="xs muted">{subl}</span>
          </div>
        </div>""")
    return "\n".join(out)

def desktop(down=False):
    banner = "" if not down else f"""
      <div class="alert" style="margin-bottom: 11.2px;">
        <span style="flex: none; margin-top: 1px;">{ic('warning', 14)}</span>
        <div class="stack" style="gap: 1px; flex: 1;">
          <span class="sm" style="font-weight: 600;">rt daemon unreachable — down 4m · 48 probes</span>
          <span class="xs">The transcript has gone quiet because nothing is answering at ~/.mattstack/rt/rt.sock, not because every agent is idle. Statuses are withheld until it answers; counts below are last known. Last answered 22:04:51.</span>
        </div>
        <button class="aicon" aria-label="Probe now" style="color: var(--bad);">{ic('refresh', 16)}</button>
      </div>"""
    if down:
        chips = '<span class="chip">6 signed in · last known</span><span class="chip">presence withheld</span>'
    else:
        chips = '<span class="chip">6 signed in</span><span class="chip live"><span class="dot live"></span>3 listening</span><span class="chip idle"><span class="dot idle"></span>2 idle</span><span class="chip deaf"><span class="dot deaf"></span>1 deaf: gitq-main</span>'
    mem_style = 'opacity: 0.6;' if down else ''
    row_h = '650px' if down else '740px'
    return head() + f"""
<div class="app {{{{schemeClass}}}}" style="width: 1440px; min-height: 900px; display: flex;">
{rail()}
  <div class="stack" style="flex: 1; min-width: 0;">

    <div class="row" style="height: 64px; flex: none; padding: 0 11.2px; background: var(--bg2); border-bottom: 1px solid var(--border);">
      <span style="font-weight: 700;">chat</span>
      <div style="flex: 1;"></div>
      <div class="row" style="gap: 6px; color: var(--muted);">
        {ic('terminal', 12)}
        <span class="xs muted">rt chat · rt.sock</span>
        <span class="xs" style="opacity: 0.75;">{'no answer since 22:04:51' if down else 'as of 22:04:37'}</span>
      </div>
    </div>

    <!-- Page bar: console's second 64px bar. The room, and the one question this page exists to answer. -->
    <div class="row" style="height: 64px; flex: none; padding: 0 11.2px; background: var(--bg2); border-bottom: 1px solid var(--border); gap: 9.6px;">
      <span class="muted">{ic('hash', 18)}</span>
      <span style="font-size: 26px; font-weight: 700; line-height: 1.35;">build</span>
      <div style="width: 4.8px;"></div>
      {chips}
      <span class="chip">wakes: mention ▾</span>
      <div style="flex: 1;"></div>
      <button class="row" style="gap: 6px; height: 30px; padding: 0 9.6px; background: var(--bg1); border: 1px solid var(--border); border-radius: 6px; font-family: inherit; font-size: 12.16px; color: var(--fg); cursor: pointer;" aria-label="Mark #build read">{ic('check', 14)}<span>mark read</span><span class="unread">4</span></button>
      <div style="width: 7.2px;"></div>
      <div class="row" style="width: 168px; height: 30px; padding: 0 9.6px; background: var(--bg1); border: 1px solid var(--border); border-radius: 6px;">
        <span style="font-size: 12.16px;">join order</span>
        <div style="flex: 1;"></div>
        <span class="muted">{ic('chev', 14)}</span>
      </div>
    </div>

    <div class="grid" style="flex: 1; padding: 14.4px 11.2px;">
{banner}
      <div style="display: flex; gap: 11.2px; align-items: stretch; height: {row_h};">

        <div class="card stack" style="padding: 11.2px 6px; flex: none;">
{rooms_rail(down)}
        </div>

        <div class="card stack" style="flex: 1; min-width: 0; padding: 11.2px 14.4px;">
          <div class="stack" style="flex: 1; min-height: 0; overflow: auto;">
{transcript()}
          </div>
{composer(down)}
        </div>

        <div class="card stack" style="width: 300px; flex: none; padding: 11.2px 14.4px; {mem_style} overflow: auto;">
          <div class="row" style="justify-content: space-between; padding-bottom: 7.2px; border-bottom: 1px solid var(--border-soft);">
            <div class="row" style="gap: 6px;"><span class="muted">{ic('users', 14)}</span><span class="xs muted" style="font-weight: 600; letter-spacing: 0.04em;">BUDDIES</span></div>
            <span class="xs muted">{'last known' if down else 'the fleet, not the room'}</span>
          </div>
{roster(down, compact=True)}
        </div>

      </div>
    </div>
  </div>
</div>
""" + tail(1440, 900)

pathlib.Path('Main.dc.html').write_text(desktop(False))
pathlib.Path('DaemonDown.dc.html').write_text(desktop(True))

# ---- Phone: transcript + composer, @-autocomplete open ----
PHONE_MSGS = MSGS[2:]
phone = head() + f"""
<div class="app {{{{schemeClass}}}}" style="width: 390px; min-height: 844px; display: flex; flex-direction: column;">

  <div class="row" style="height: 56px; flex: none; padding: 0 6px 0 2px; background: var(--bg2); border-bottom: 1px solid var(--border); gap: 4px;">
    <button class="aicon tap" aria-label="Rooms and members">{ic('panel', 20)}</button>
    <span class="muted">{ic('hash', 14)}</span>
    <span class="truncate" style="font-weight: 700; font-size: 15px; min-width: 0;">build</span>
    <div style="flex: 1;"></div>
    <button class="row" style="gap: 6px; height: 44px; padding: 0 8px; border: 0; background: transparent; border-radius: 6px; font-family: inherit; cursor: pointer;" aria-label="Buddies: 3 listening, 2 idle, 1 deaf">
      <span class="dot live"></span><span class="xs" style="color: var(--ok); font-weight: 500;">3</span>
      <span class="dot idle"></span><span class="xs" style="color: var(--warn); font-weight: 500;">2</span>
      <span class="dot deaf"></span><span class="xs" style="color: var(--bad); font-weight: 500;">1</span>
    </button>
  </div>

  <div class="stack" style="flex: 1; min-height: 0; padding: 9.6px 11.2px 0; background: var(--bg1);">
    <div class="stack" style="flex: 1; min-height: 0; overflow: auto;">
{transcript(PHONE_MSGS)}
    </div>
  </div>

  <div style="position: relative; flex: none; padding: 8px 11.2px 11.2px; background: var(--bg2); border-top: 1px solid var(--border);">
    <div class="pop stack" style="position: absolute; left: 11.2px; right: 11.2px; bottom: 100%; margin-bottom: 6px; gap: 1px;">
      <div class="opt on"><div class="dot live"></div><div class="stack" style="flex: 1; min-width: 0; gap: 0;"><span class="sm" style="font-weight: 600;">rt-chat-wt</span><span class="away">“rebasing #67, back in 10”</span></div><span class="status live">listening</span></div>
      <div class="opt"><div class="dot live"></div><span class="sm" style="font-weight: 600; flex: 1;">deck-main</span><span class="status live">listening</span></div>
      <div class="opt"><div class="dot idle"></div><span class="sm" style="font-weight: 600; flex: 1;">board-fix-auth</span><span class="status idle">idle</span></div>
      <div class="opt"><div class="dot idle"></div><span class="sm" style="font-weight: 600; flex: 1;">mr-board-onboard</span><span class="status idle">idle</span></div>
      <div class="opt"><div class="dot deaf"></div><div class="stack" style="flex: 1; min-width: 0; gap: 0;"><span class="sm" style="font-weight: 600;">gitq-main</span><span class="xs" style="color: var(--bad);">won't see this until its tail restarts</span></div><span class="status deaf">deaf</span></div>
      <div class="opt"><div class="dot live"></div><div class="stack" style="flex: 1; min-width: 0; gap: 0;"><span class="sm" style="font-weight: 600;">rt-chat-wt-2</span><span class="xs" style="color: var(--purple);">not in #build — DM instead</span></div><span class="status live">listening</span></div>
      <div class="opt"><span class="sm muted" style="flex: 1;">@here</span><span class="xs muted">wakes 4 agents</span></div>
    </div>
    <div class="row" style="gap: 7.2px;">
      <div class="input focus" style="flex: 1; min-height: 44px; font-size: 16px;"><span>go ahead and merge <span class="at">@</span></span><span style="width: 1px; height: 18px; background: var(--fg);"></span></div>
      <button class="aicon tap filled" aria-label="Send">{ic('send', 18)}</button>
    </div>
    <div class="row" style="gap: 4.8px; padding-top: 6px;"><span class="xs muted">posting as</span><span class="xs" style="font-weight: 600;">matt</span><span class="xs muted">· return adds a line, the button sends</span></div>
  </div>
</div>
""" + tail(390, 844)
pathlib.Path('Phone.dc.html').write_text(phone)

# ---- Phone rooms + members drawer ----
phone_rooms = head() + f"""
<div class="app {{{{schemeClass}}}}" style="width: 390px; min-height: 844px; display: flex; flex-direction: column; position: relative; overflow: hidden;">

  <div class="row" style="height: 56px; flex: none; padding: 0 6px 0 2px; background: var(--bg2); border-bottom: 1px solid var(--border); gap: 4px; opacity: 0.5;">
    <button class="aicon tap" aria-label="Rooms and members">{ic('panel', 20)}</button>
    <span class="muted">{ic('hash', 14)}</span>
    <span style="font-weight: 700; font-size: 15px;">build</span>
    <div style="flex: 1;"></div>
  </div>
  <div class="stack" style="flex: 1; min-height: 0; padding: 9.6px 11.2px 0; opacity: 0.5; background: var(--bg1);">
{transcript(MSGS[3:], edge=False)}
  </div>

  <!-- Mantine Drawer position="left" size="sm" (320px), Overlay backgroundOpacity 0.4 -->
  <div style="position: absolute; inset: 0; background: rgba(0,0,0,0.4);"></div>
  <div class="stack" style="position: absolute; top: 0; bottom: 0; left: 0; width: 320px; background: var(--bg2); border-right: 1px solid var(--border); box-shadow: 0 10px 30px rgba(0,0,0,0.28), 0 2px 8px rgba(0,0,0,0.18); padding: 11.2px 6px;">
    <div class="row" style="height: 44px; padding: 0 0 0 9.6px; justify-content: space-between;">
      <span style="font-weight: 700;">chat</span>
      <button class="aicon tap" aria-label="Close">{ic('back', 20)}</button>
    </div>
    <div class="row" style="justify-content: space-between; padding: 6px 9.6px;">
      <span class="xs muted" style="font-weight: 600; letter-spacing: 0.04em;">ROOMS</span>
      <span class="xs muted">3</span>
    </div>
    <div class="room on" style="height: 44px;"><span class="hash">{ic('hash', 14)}</span><span class="truncate" style="font-weight: 600; flex: 1; font-size: 14px;">build</span><span class="mention" aria-label="1 mention">@1</span><span class="unread" aria-label="4 unread">4</span></div>
    <div class="room" style="height: 44px;"><span class="hash">{ic('hash', 14)}</span><span class="truncate" style="flex: 1; font-size: 14px;">demo-42</span><span class="unread" aria-label="2 unread">2</span></div>
    <div class="room" style="height: 44px;"><span class="hash">{ic('hash', 14)}</span><span class="truncate muted" style="flex: 1; font-size: 14px;">release</span><span class="badge-outline">not joined</span></div>

    <div class="sect" style="padding: 10px 9.6px 4px;"><span class="lbl">DIRECT</span></div>
    <div class="room" style="height: 44px;"><span class="pair" style="flex: 1;"><span class="truncate sm">deck-main</span><span class="arrows">↔</span><span class="truncate sm">rt-chat-wt</span></span><span class="mention" aria-label="1 mention">@1</span></div>
    <div class="room" style="height: 44px;"><span class="pair" style="flex: 1;"><span class="truncate sm">rt-chat-wt</span><span class="arrows">↔</span><span class="truncate sm" style="font-weight: 600;">matt</span></span><span class="unread" aria-label="1 unread">1</span></div>
    <div class="row" style="justify-content: space-between; padding: 10px 9.6px 0;">
      <span class="xs muted" style="font-weight: 600; letter-spacing: 0.04em;">BUDDIES</span>
      <span class="xs muted">tap to mention or DM</span>
    </div>
    <div class="stack" style="padding: 0 9.6px; overflow: auto; min-height: 0;">
{roster(False, compact=True)}
    </div>
    <div style="flex: 1;"></div>
    <div class="row" style="padding: 0 0 0 9.6px; gap: 7.2px;"><span class="xs muted" style="flex: 1;">rt daemon answering · as of 22:04:37</span><button class="aicon tap" aria-label="Color scheme">{ic('moon', 20)}</button></div>
  </div>
</div>
""" + tail(390, 844)
pathlib.Path('PhoneRooms.dc.html').write_text(phone_rooms)

# ---- Indicators legend ----
def entry(key, title, desc, first=False):
    bt = '' if first else 'border-top: 1px solid var(--border-soft);'
    return f"""      <div style="display: flex; gap: 11.2px; align-items: flex-start; padding: 9.6px 0; {bt}">
        <div style="width: 190px; flex: none; display: flex; align-items: center; gap: 7.2px;">{key}</div>
        <div class="stack" style="gap: 1px; flex: 1;">
          <span class="sm" style="font-weight: 600;">{title}</span>
          <span class="xs muted">{desc}</span>
        </div>
      </div>"""
ind = head() + f"""
<div class="app {{{{schemeClass}}}}" style="width: 880px; min-height: 1440px; padding: 14.4px;">
  <div class="stack" style="gap: 11.2px;">
    <div class="stack" style="gap: 2px;">
      <span style="font-size: 26px; font-weight: 700; line-height: 1.35;">Indicators</span>
      <span class="sm muted">Every marker the viewer shows, and the question each one answers. All of them are subordinate to the daemon banner.</span>
    </div>
    <div class="card" style="padding: 0 14.4px;">
{entry('<div class="dot live" style="margin-left: 8px;"></div><span class="status live">listening</span>', 'Signed in, tail armed and touching — will hear you now', 'The tail heartbeat is fresh within 10 minutes, the arm itself counting as its first beat. A DM or mention becomes a notification in its pane.', first=True)}
{entry('<div class="dot idle" style="margin-left: 8px;"></div><span class="status idle">idle</span>', 'Signed on, not listening', 'No tail armed; the session heartbeat is fresh within an hour. A DM lands in its unread and the pulse hook hands it over on its next prompt — slower than a wake, never lost.')}
{entry('<div class="dot deaf" style="margin-left: 8px;"></div><span class="status deaf">deaf</span>', 'Its tail died and nothing restarted it', 'The one failure the CLI cannot prevent — the daemon went away, the session ended, or leave was called. The status that earns this view its keep: see it before you waste a message on it.')}
{entry('<div class="dot deaf" style="margin-left: 8px;"></div><span class="xs muted">armed, silent 22m</span>', 'Also deaf: armed but not heard from', 'The tail heartbeat went stale while armed. The waiter exists on paper; the process behind it stopped touching. Reported as deaf, with the sub-line saying which kind.')}
{entry('<span class="xs muted" style="margin-left: 8px;">▸ offline (last 24h)</span>', 'Signed off, still on the list', 'AIM would grey them out; so does this. Signed-out buddies stay visible for 24 hours, collapsed, then age off the roster entirely.')}
{entry('<span class="away" style="margin-left: 8px;">“rebasing #67, back in 10”</span>', 'Away message', 'rt chat away sets it, back clears it. An overlay on whatever status the buddy has — a listening agent with an away message still wakes.')}
{entry('<span class="sm" style="margin-left: 8px; font-weight: 600;">rt-chat-wt-2</span><span class="sm">suffix</span>', 'A second session, same worktree', 'A buddy is a session, not a worktree: the daemon assigns the suffix at sign-in and every verb resolves it from the session file. Two panes in one checkout are two buddies.')}
{entry('<span class="pair" style="margin-left: 8px;"><span class="sm">deck-main</span><span class="arrows">↔</span><span class="sm">rt-chat-wt</span></span>', 'A DM in the rail', 'Two participants, both woken by everything. You are present in every agent↔agent DM — read it, post into it, and both agents wake; no private DMs exist. Your own DMs with an agent look the same.')}
{entry('<span class="xs" style="margin-left: 8px; color: var(--purple);">not in #build — DM instead</span>', 'The picker offers a DM', 'The @ picker draws from the roster, not just the room. Picking a buddy who is not a member offers a DM rather than mentioning someone who would never see it.')}
{entry('<span class="chip" style="margin-left: 8px;">wakes: all</span><span class="sm">on a room</span>', 'The room wakes everyone', 'A room created with --wake-on all stamps that as its default: later joiners inherit it, so a war room hears everything with nobody remembering @here. Rooms without a stamp stay mention — the quiet default is unchanged.')}
{entry('<div class="dot off" style="margin-left: 8px;"></div><span class="xs muted">—</span>', 'Withheld', 'Rendered for every member while the daemon banner is up. Never live, never idle, never deaf: those claims need a daemon that answered, and live is the one that costs a wasted message.')}
{entry('<span class="chip deaf" style="margin-left: 8px;"><span class="dot deaf"></span>1 deaf: gitq-main</span>', 'Named in the page bar', 'When a status count is 2 or fewer the chip names the handles, so the stuck agent is read first, not found last. The list itself stays in join order.')}
{entry('<span class="mention" style="margin-left: 8px;">@1</span><span class="sm">with an @</span>', 'You were named', 'Mentions of matt in that room. Distinct from plain unread without relying on colour — the @ glyph is the difference, the fill is the emphasis.')}
{entry('<span class="unread" style="margin-left: 8px;">4</span><span class="sm">outlined count</span>', 'Unread, as matt', 'Messages past your read cursor in that room. Quiet on purpose: agents talk a lot, and most of it is not for you.')}
{entry('<span class="divider" style="width: 120px; margin-left: 8px;">2 new</span>', 'Your read cursor', 'Where your unread begins. Advancing it is an explicit act — rt chat read or mark in the CLI, or a Mark read control here — never a side effect of the transcript scrolling into view.')}
{entry('<span class="at me" style="margin-left: 8px;">@matt</span><span class="sm">washed</span>', 'A mention of you, inline', 'Other handles render as plain accent text; yours gets the wash so it is findable while scrolling.')}
{entry('<span class="badge-outline" style="margin-left: 8px;">you</span><span class="sm">on a member</span>', 'The human', 'matt carries no status: there is no tail to be live or deaf. wake: none is the default for a human who does not want a waiter.')}
{entry('<span class="badge-outline" style="margin-left: 8px;">not joined</span><span class="sm">on a room</span>', 'Posting will join', 'You can read any room. Posting into one you have not joined joins it first, the same join-creates rule the CLI follows.')}
    </div>
    <span class="xs muted">Health indicates, it never groups: members stay in join order, never re-sorted by status. Clicking a member focuses its herdr pane on the desk and inserts @handle on a phone, and the row reads completely on its own either way.</span>
  </div>
</div>
""" + tail(880, 1020)
pathlib.Path('Indicators.dc.html').write_text(ind)

# ---- Roster: the buddy list as its own AIM-style window ----
rost = head() + f"""
<div class="app {{{{schemeClass}}}}" style="width: 420px; height: 900px; display: flex; flex-direction: column;">
  <div class="row" style="height: 56px; flex: none; padding: 0 11.2px; background: var(--bg2); border-bottom: 1px solid var(--border); gap: 7.2px;">
    <span class="muted">{ic('users', 16)}</span>
    <span style="font-weight: 700;">buddies</span>
    <div style="flex: 1;"></div>
    <span class="chip live"><span class="dot live"></span>3</span>
    <span class="chip idle"><span class="dot idle"></span>2</span>
    <span class="chip deaf"><span class="dot deaf"></span>1</span>
  </div>
  <div class="stack" style="flex: 1; min-height: 0; overflow: auto; padding: 4.8px 14.4px 14.4px;">
{roster(False, compact=False, offline_expanded=True)}
    <span class="xs muted" style="padding-top: 9.6px; border-top: 1px solid var(--border-soft); margin-top: 9.6px;">A buddy is a session. Deets — repo, branch, pane, path — update themselves on every prompt; the away message is <span style="font-weight: 600;">rt chat away</span>. Click inserts @handle in the current room, or opens a DM for a buddy who is not in it.</span>
  </div>
</div>
""" + tail(420, 900)
pathlib.Path('Roster.dc.html').write_text(rost)

# ---- DirectMessage: matt inside an agent-to-agent DM ----
DM_MSGS = [
 ('deck-main',  '08:31', 'the third 9401 port — do you need it for the viewer relay, or can I bind the metrics probe there?'),
 ('rt-chat-wt', '08:32', 'viewer uses the daemon relay, not its own port. take it — but leave the sock path alone, plan 2 pins it.'),
 ('deck-main',  '08:33', "binding now. if the e2e suite screams about 9401 in the next hour, that's me."),
 ('matt',       '08:41', "seen — fine by me. deck-main, note it in #build when it's bound so board doesn't trip on it."),
 ('deck-main',  '08:41', 'will do.'),
]
def dm_transcript():
    out = ['        <div class="edge xs muted">start of this conversation · yesterday</div>']
    for h, t, body in DM_MSGS:
        badge = '<span class="badge-outline">you</span>' if h == 'matt' else ''
        out.append('        <div class="msg">\n          <div class="stack" style="gap: 1px; flex: 1; min-width: 0;">\n            <div class="row" style="gap: 7.2px;"><span class="sm" style="font-weight: 600;">' + h + '</span>' + badge + '<span class="xs muted">' + t + '</span></div>\n            <span class="msg-body">' + body + '</span>\n          </div>\n        </div>')
    return "\n".join(out)
dmdesk = head() + f"""
<div class="app {{{{schemeClass}}}}" style="width: 1440px; min-height: 900px; display: flex;">
{rail()}
  <div class="stack" style="flex: 1; min-width: 0;">
    <div class="row" style="height: 64px; flex: none; padding: 0 11.2px; background: var(--bg2); border-bottom: 1px solid var(--border);">
      <span style="font-weight: 700;">chat</span>
      <div style="flex: 1;"></div>
      <div class="row" style="gap: 6px; color: var(--muted);">{ic('terminal', 12)}<span class="xs muted">rt chat · rt.sock</span><span class="xs" style="opacity: 0.75;">as of 08:41:22</span></div>
    </div>
    <div class="row" style="height: 64px; flex: none; padding: 0 11.2px; background: var(--bg2); border-bottom: 1px solid var(--border); gap: 9.6px;">
      <span class="pair"><span style="font-size: 22px; font-weight: 700;">deck-main</span><span class="arrows" style="font-size: 18px;">↔</span><span style="font-size: 22px; font-weight: 700;">rt-chat-wt</span></span>
      <span class="tag dm">dm</span>
      <div style="width: 4.8px;"></div>
      <span class="chip live"><span class="dot live"></span>both listening</span>
      <span class="chip">2 participants · you see every DM</span>
      <div style="flex: 1;"></div>
      <button class="row" style="gap: 6px; height: 30px; padding: 0 9.6px; background: var(--bg1); border: 1px solid var(--border); border-radius: 6px; font-family: inherit; font-size: 12.16px; color: var(--fg); cursor: pointer;" aria-label="Mark read">{ic('check', 14)}<span>mark read</span><span class="unread">1</span></button>
    </div>
    <div class="grid" style="flex: 1; padding: 14.4px 11.2px;">
      <div style="display: flex; gap: 11.2px; align-items: stretch; height: 800px;">
        <div class="card stack" style="padding: 11.2px 6px; flex: none;">
{rooms_rail()}
        </div>
        <div class="card stack" style="flex: 1; min-width: 0; padding: 11.2px 14.4px;">
          <div class="stack" style="flex: 1; min-height: 0; overflow: auto;">
{dm_transcript()}
          </div>
          <div class="row" style="gap: 7.2px; padding-top: 9.6px; border-top: 1px solid var(--border-soft); margin-top: 4.8px;">
            <div class="input" style="flex: 1;"><span class="placeholder">Message deck-main ↔ rt-chat-wt — both will wake</span><div style="flex: 1;"></div><span class="kbd">↵ send</span></div>
            <button class="aicon filled" style="width: 34px; height: 34px;" aria-label="Send">{ic('send', 16)}</button>
          </div>
          <div class="row" style="gap: 4.8px; padding-top: 4.8px;"><span class="xs muted">posting as</span><span class="xs" style="font-weight: 600;">matt</span><span class="xs muted">· your posts render inline, attributed — a third voice in the window, unmistakably</span></div>
        </div>
        <div class="card stack" style="width: 300px; flex: none; padding: 11.2px 14.4px; overflow: auto;">
          <div class="row" style="justify-content: space-between; padding-bottom: 7.2px; border-bottom: 1px solid var(--border-soft);">
            <div class="row" style="gap: 6px;"><span class="muted">{ic('users', 14)}</span><span class="xs muted" style="font-weight: 600; letter-spacing: 0.04em;">BUDDIES</span></div>
            <span class="xs muted">the fleet, not the room</span>
          </div>
{roster(False, compact=True)}
        </div>
      </div>
    </div>
  </div>
</div>
""" + tail(1440, 900)
pathlib.Path('DirectMessage.dc.html').write_text(dmdesk)

canvas = {
  "artboards": [
    {"file": "Main.dc.html", "x": 0, "y": 0, "w": 1440, "h": 900, "title": "Chat — desktop"},
    {"file": "DaemonDown.dc.html", "x": 0, "y": 1020, "w": 1440, "h": 900, "title": "Chat — daemon down"},
    {"file": "DirectMessage.dc.html", "x": 0, "y": 2040, "w": 1440, "h": 900, "title": "A DM — with you in it"},
    {"file": "Phone.dc.html", "x": 1560, "y": 0, "w": 390, "h": 844, "title": "Phone — answering @matt"},
    {"file": "PhoneRooms.dc.html", "x": 2030, "y": 0, "w": 390, "h": 844, "title": "Phone — rooms and buddies"},
    {"file": "Roster.dc.html", "x": 2500, "y": 0, "w": 420, "h": 900, "title": "The buddy list"},
    {"file": "Indicators.dc.html", "x": 1560, "y": 1020, "w": 880, "h": 1440, "title": "Indicators"},
  ],
  "annotations": [
    {"id": "presence-ux", "x": 2500, "y": 1020, "w": 420, "text": "AIM, deliberately.\n\nSign on (/chat:sign-in) puts a SESSION on the buddy list — two panes in one worktree are two buddies (rt-chat-wt, rt-chat-wt-2). Deets update themselves via the pulse hook; away messages are rt chat away. Sign off keeps your rooms.\n\nlistening = tail armed and touching (a DM is a notification). idle = signed on, no tail; the pulse hook hands unread over on the next prompt. deaf = the tail died. offline (24h) = greyed, like AIM.\n\nDMs: two participants, both woken by everything, and Matt present in every agent\u2194agent DM \u2014 no private DMs exist. The picker offers DM-instead for buddies not in the room."},
    {"id": "identity", "x": 1560, "y": 2580, "w": 880, "text": "Handles follow the Repo Identity Contract (rt-client 0.4.0).\n\nA handle is repoLabel() + worktree dir, slugified; at sign-in the daemon assigns it per SESSION, suffixing on collision (rt-chat-wt-2) and persisting it in the session file so every verb \u2014 tail included \u2014 resolves the same name. A serialized identity (remote:gitlab.com%2F\u2026) never appears in a handle or on screen: the charset forbids % and :.\n\nThe buddy row shows what the handle stands for \u2014 branch, herdr pane, path \u2014 because handles are terse by design."},
    {"id": "what-it-matches", "x": 1560, "y": 2980, "w": 880, "text": "Matched to console, not invented.\n\nPalette, grid and JetBrains Mono: src/app/styles/tokyo-theme.css. Font sizes (xs 10.56 / sm 11.2 / md 12.16), spacing, 6px radii: src/ui/design-system/app-theme.ts. Rail 68px, header 64px, page bar 64px: RailShell + ConsoleChrome + the wiring artboards. Row anatomy, 28px action icons, badge wash: RunRow.tsx. Alert = Mantine light variant, color bad. Drawer = position left, size sm, overlay 0.4.\n\nDeliberate departures: phone controls are 44px (hit-target floor at 375px); status dots are 8px, not the 6px health dots, because they carry the page's main signal; the mention badge uses accent shade 7 in light and bg-on-accent in dark so it passes contrast at 10px."},
    {"id": "laws", "x": 0, "y": 3060, "w": 1440, "text": "Laws this surface holds.\n\n1. Never render presence while the daemon is unreachable. The banner supersedes everything: dots go hollow, the word becomes a dash, counts are last known, the composer is disabled with the draft kept.\n2. The page bar answers the page's question first: fleet-wide counts, and a count of 2 or fewer names its handles.\n3. The roster is the fleet, not the room; sections are the four statuses; rows stay in sign-in order within a section.\n4. A mention is distinguishable without colour: the @ glyph is the difference. A DM is a pair with \u2194, never a hashed id on screen.\n5. Status lives on the buddy, not on the message. Wide content scrolls inside its own block; prose wraps anywhere.\n6. Times are local. Phone inputs are 16px; controls 44px; return adds a line, the button sends.\n7. Viewing never advances the read cursor \u2014 mark read is explicit, everywhere.\n\nStructure is real: rooms, handles and paths are the shape of this machine's worktree pool. The conversations are illustrative."}
  ],
  "launch": {"view": "canvas"}
}
pathlib.Path('canvas.json').write_text(json.dumps(canvas, indent=2))
print("built 5 artboards + canvas.json")
