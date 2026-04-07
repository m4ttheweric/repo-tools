#!/usr/bin/env swift
/**
 * make-icon.swift — rt-tray app icon generator
 *
 * Draws the "rt" wordmark at every required macOS iconset size using Core
 * Graphics, then shells out to `iconutil` to produce AppIcon.icns.
 *
 * Run from the rt-tray directory:
 *   swift make-icon.swift
 *
 * Output:
 *   ./AppIcon.iconset/   (intermediate PNGs, safe to delete)
 *   ./AppIcon.icns       (final icon — copied into the .app bundle by build.sh)
 */

import Foundation
import CoreGraphics
import AppKit

// ── Design tokens ─────────────────────────────────────────────────────────────
// Exact values from runner.tsx T palette — single source of truth.
// T.bgBase  = [22, 18, 36]   #161224  dark plum-black  (canvas fill)
// T.pink    = [255, 107, 157] #FF6B9D  rose pink        (primary / borders / active)
let bgR: CGFloat = 22  / 255   //  ╮
let bgG: CGFloat = 18  / 255   //  ├─ T.bgBase  #161224
let bgB: CGFloat = 36  / 255   //  ╯

let fgR: CGFloat = 255 / 255   //  ╮
let fgG: CGFloat = 107 / 255   //  ├─ T.pink    #FF6B9D
let fgB: CGFloat = 157 / 255   //  ╯

// ── Preferred fonts (in order) ────────────────────────────────────────────────
let fontNames: [String] = ["SF Mono", "Menlo", "Courier New"]

// ── Iconset sizes ─────────────────────────────────────────────────────────────
struct Slot {
    let filename: String   // without .png extension
    let points:   Int      // logical size
    let scale:    Int      // 1 or 2 (@2x)
    var pixels: Int { points * scale }
}

let slots: [Slot] = [
    Slot(filename: "icon_16x16",       points: 16,  scale: 1),
    Slot(filename: "icon_16x16@2x",    points: 16,  scale: 2),
    Slot(filename: "icon_32x32",       points: 32,  scale: 1),
    Slot(filename: "icon_32x32@2x",    points: 32,  scale: 2),
    Slot(filename: "icon_128x128",     points: 128, scale: 1),
    Slot(filename: "icon_128x128@2x",  points: 128, scale: 2),
    Slot(filename: "icon_256x256",     points: 256, scale: 1),
    Slot(filename: "icon_256x256@2x",  points: 256, scale: 2),
    Slot(filename: "icon_512x512",     points: 512, scale: 1),
    Slot(filename: "icon_512x512@2x",  points: 512, scale: 2),
]

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Create the best available monospace font at the requested size.
func makeFont(size: CGFloat) -> CTFont {
    for name in fontNames {
        let f = CTFontCreateWithName(name as CFString, size, nil)
        // CTFontCreateWithName always returns a font; check it's actually the
        // requested face (not a fallback) by inspecting the descriptor name.
        let actual = CTFontCopyName(f, kCTFontPostScriptNameKey) as String? ?? ""
        if actual.lowercased().contains(name.lowercased().prefix(5)) {
            return f
        }
    }
    // Last resort: system monospaced
    return CTFontCreateUIFontForLanguage(.system, size, nil)
        ?? CTFontCreateWithName("Menlo" as CFString, size, nil)
}

/// Render one icon PNG into the iconset directory.
func renderSlot(_ slot: Slot, into iconsetDir: String) {
    let px = slot.pixels
    let cs = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
        data: nil,
        width:  px,
        height: px,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: cs,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        print("  ✗ Could not create CGContext for \(slot.filename)")
        return
    }

    let size   = CGFloat(px)
    let radius = size * 0.225          // matches macOS icon corner rounding

    // ── Background ────────────────────────────────────────────────────────────
    ctx.setFillColor(CGColor(red: bgR, green: bgG, blue: bgB, alpha: 1))
    let iconRect = CGRect(x: 0, y: 0, width: size, height: size)
    ctx.addPath(CGPath(roundedRect: iconRect,
                       cornerWidth: radius, cornerHeight: radius,
                       transform: nil))
    ctx.fillPath()

    // ── "rt" text ─────────────────────────────────────────────────────────────
    // Scale the font so the caps-height fills roughly 50% of the icon.
    let fontSize = size * 0.44
    let font     = makeFont(size: fontSize)
    let nsFont   = font as NSFont        // toll-free bridged

    let attrs: [NSAttributedString.Key: Any] = [
        .font:            nsFont,
        .foregroundColor: NSColor(calibratedRed: fgR, green: fgG, blue: fgB, alpha: 1),
    ]
    let attrStr = NSAttributedString(string: "rt", attributes: attrs)
    let line    = CTLineCreateWithAttributedString(attrStr)

    // Measure the line for optical centering
    var ascent  : CGFloat = 0
    var descent : CGFloat = 0
    var leading : CGFloat = 0
    let lineW = CTLineGetTypographicBounds(line, &ascent, &descent, &leading)
    let lineH = ascent + descent

    // Nudge x slightly right and y slightly up for optical balance
    let x = (size - lineW) / 2.0 + size * 0.01
    let y = (size - lineH) / 2.0 + descent + size * 0.01

    ctx.textPosition = CGPoint(x: x, y: y)
    CTLineDraw(line, ctx)

    // ── Export PNG ────────────────────────────────────────────────────────────
    guard let cgImage = ctx.makeImage() else {
        print("  ✗ Could not make CGImage for \(slot.filename)")
        return
    }
    let rep = NSBitmapImageRep(cgImage: cgImage)
    guard let pngData = rep.representation(using: .png, properties: [:]) else {
        print("  ✗ Could not encode PNG for \(slot.filename)")
        return
    }
    let path = "\(iconsetDir)/\(slot.filename).png"
    do {
        try pngData.write(to: URL(fileURLWithPath: path))
        print("  ✓ \(slot.filename).png  (\(px)×\(px))")
    } catch {
        print("  ✗ Write failed for \(path): \(error)")
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

let iconsetDir = "AppIcon.iconset"

do {
    try FileManager.default.createDirectory(
        atPath: iconsetDir,
        withIntermediateDirectories: true,
        attributes: nil
    )
} catch {
    print("✗ Could not create iconset directory: \(error)")
    exit(1)
}

print("  Drawing icon slices…")
for slot in slots {
    renderSlot(slot, into: iconsetDir)
}

// ── iconutil ──────────────────────────────────────────────────────────────────
print("  Running iconutil…")
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments     = ["-c", "icns", iconsetDir, "-o", "AppIcon.icns"]
do {
    try iconutil.run()
    iconutil.waitUntilExit()
} catch {
    print("✗ iconutil launch failed: \(error)")
    exit(1)
}

if iconutil.terminationStatus == 0 {
    print("  ✓ AppIcon.icns written")
} else {
    print("✗ iconutil exited with status \(iconutil.terminationStatus)")
    exit(Int32(iconutil.terminationStatus))
}
