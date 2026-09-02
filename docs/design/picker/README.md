# Picker design boards — the parity reference

These `.dc.html` artboards (+ `canvas.json`) are the signed-off visual contract
for the rt picker rebuild (2026-08-31). The live canvas is published at
https://claude.ai/code/artifact/fc997519-5f71-4011-b1a9-ef662504edbd — these
files are its committed source of truth.

They are not documentation of what was built; they are the standard the built
TUI is scrutinized against. Any review of the picker (implementation review,
polish pass, regression check) compares real Ghostty captures against these
boards, surface by surface. Deviations are either fixed in the TUI or ratified
by updating the board in the same change — the two never drift silently.

Terminal-fidelity deltas that are ratified (the boards show CSS, the terminal
is cell-quantized): no drop shadows (modal lift = Surface token + Panel border
+ parent dim), rounded corners only as box-drawing glyphs on modals, 1-cell
scrollbar thumb, fixed cell line-height. Everything else on the boards is the
contract, including exact tokens, glyphs, spacing rhythm, keybar grammar, and
every interaction state.
