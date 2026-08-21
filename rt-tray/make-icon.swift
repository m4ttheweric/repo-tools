#!/usr/bin/env swift
/**
 * make-icon.swift — mattstack app icon generator
 *
 * Draws the "m" wordmark at every required macOS iconset size using Core
 * Graphics, then shells out to `iconutil` to produce AppIcon.icns.
 *
 * Generates BOTH bundle flavors in one run (cheap — a couple dozen small
 * PNGs each): the prod icon (AppIcon.iconset/AppIcon.icns) and a visibly
 * tinted dev variant (AppIcon-dev.iconset/AppIcon-dev.icns). build.sh picks
 * whichever .icns matches the flavor it's assembling and copies it into the
 * bundle as Contents/Resources/AppIcon.icns — the bundle-internal name stays
 * "AppIcon" for both flavors (that's what Info.plist's CFBundleIconFile
 * names); only the source file build.sh copies FROM differs per flavor.
 *
 * Run from the rt-tray directory:
 *   swift make-icon.swift
 *
 * Output:
 *   ./AppIcon.iconset/       ./AppIcon.icns       (prod — copied by build.sh)
 *   ./AppIcon-dev.iconset/   ./AppIcon-dev.icns   (dev  — copied by build.sh)
 */

import Foundation
import CoreGraphics
import AppKit

// ── Design tokens ─────────────────────────────────────────────────────────────
// Exact values from runner.tsx T palette — single source of truth for prod.
// T.bgBase  = [22, 18, 36]   #161224  dark plum-black  (canvas fill)
// T.pink    = [255, 107, 157] #FF6B9D  rose pink        (primary / borders / active)
//
// The dev flavor reuses the same background but swaps the wordmark to amber
// (#FFB347) so the two flavors are unmistakable side by side in the menu bar
// and in Finder/Launchpad, without standing up a separate icon pipeline.
struct Palette {
    let bg: (CGFloat, CGFloat, CGFloat)
    let fg: (CGFloat, CGFloat, CGFloat)
}

let prodPalette = Palette(
    bg: (22 / 255, 18 / 255, 36 / 255),    // #161224 dark plum-black
    fg: (255 / 255, 107 / 255, 157 / 255)  // #FF6B9D rose pink
)

let devPalette = Palette(
    bg: (22 / 255, 18 / 255, 36 / 255),    // same canvas — only the mark differs
    fg: (255 / 255, 179 / 255, 71 / 255)   // #FFB347 amber — visibly distinct from prod pink
)

struct Flavor {
    let iconsetDir: String
    let icnsPath: String
    let palette: Palette
}

let flavors: [Flavor] = [
    Flavor(iconsetDir: "AppIcon.iconset", icnsPath: "AppIcon.icns", palette: prodPalette),
    Flavor(iconsetDir: "AppIcon-dev.iconset", icnsPath: "AppIcon-dev.icns", palette: devPalette),
]

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

/// Stroke the lucide "layers" glyph (a stacked-diamonds mark) into `rect`.
/// Straight segments with round caps/joins reproduce the rounded corners the
/// SVG spells as tiny arcs, so no arc parsing is needed.
func drawLayersGlyph(_ ctx: CGContext, in rect: CGRect, color: CGColor) {
    // Point coordinates in the glyph's native 24×24 box (SVG y-down).
    let diamond: [(CGFloat, CGFloat)] = [(12, 2.5), (21.8, 7.0), (12, 11.5), (2.2, 7.0)]
    let midChevron: [(CGFloat, CGFloat)] = [(2.2, 12.3), (12, 16.8), (21.8, 12.3)]
    let bottomChevron: [(CGFloat, CGFloat)] = [(2.2, 17.3), (12, 21.8), (21.8, 17.3)]

    func point(_ p: (CGFloat, CGFloat)) -> CGPoint {
        CGPoint(x: rect.minX + p.0 / 24 * rect.width,
                y: rect.minY + (1 - p.1 / 24) * rect.height)   // flip: CG is y-up
    }

    let path = CGMutablePath()
    path.addLines(between: diamond.map(point))
    path.closeSubpath()
    path.move(to: point(midChevron[0]))
    path.addLines(between: midChevron.map(point))
    path.move(to: point(bottomChevron[0]))
    path.addLines(between: bottomChevron.map(point))

    ctx.saveGState()
    ctx.addPath(path)
    ctx.setStrokeColor(color)
    // 2/24 stroke like the SVG, clamped so the 16px slot doesn't vanish.
    ctx.setLineWidth(max(1.0, rect.width * 2 / 24))
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.strokePath()
    ctx.restoreGState()
}

/// Render one icon PNG into the iconset directory.
func renderSlot(_ slot: Slot, into iconsetDir: String, palette: Palette) {
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
    ctx.setFillColor(CGColor(red: palette.bg.0, green: palette.bg.1, blue: palette.bg.2, alpha: 1))
    let iconRect = CGRect(x: 0, y: 0, width: size, height: size)
    ctx.addPath(CGPath(roundedRect: iconRect,
                       cornerWidth: radius, cornerHeight: radius,
                       transform: nil))
    ctx.fillPath()

    // ── Mark: [layers glyph] + "m", centered as one group ────────────────────
    let fgColor = CGColor(red: palette.fg.0, green: palette.fg.1, blue: palette.fg.2, alpha: 1)

    let fontSize = size * 0.40
    let font     = makeFont(size: fontSize)
    let nsFont   = font as NSFont        // toll-free bridged

    let attrs: [NSAttributedString.Key: Any] = [
        .font:            nsFont,
        .foregroundColor: NSColor(calibratedRed: palette.fg.0, green: palette.fg.1, blue: palette.fg.2, alpha: 1),
    ]
    let attrStr = NSAttributedString(string: "m", attributes: attrs)
    let line    = CTLineCreateWithAttributedString(attrStr)

    // Measure the line for optical centering
    var ascent  : CGFloat = 0
    var descent : CGFloat = 0
    var leading : CGFloat = 0
    let lineW = CTLineGetTypographicBounds(line, &ascent, &descent, &leading)
    let lineH = ascent + descent

    let glyphSide = size * 0.30
    let gap       = size * 0.06
    let groupW    = lineW + gap + glyphSide
    let startX    = (size - groupW) / 2.0

    // Nudge y slightly up for optical balance (as the centered-m icon did)
    let y = (size - lineH) / 2.0 + descent + size * 0.01
    ctx.textPosition = CGPoint(x: startX, y: y)
    CTLineDraw(line, ctx)

    drawLayersGlyph(ctx, in: CGRect(x: startX + lineW + gap, y: (size - glyphSide) / 2.0,
                                    width: glyphSide, height: glyphSide),
                    color: fgColor)

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

/// Render one full iconset + .icns for a given flavor. Returns the process
/// exit status (0 on success).
func buildFlavor(_ flavor: Flavor) -> Int32 {
    do {
        try FileManager.default.createDirectory(
            atPath: flavor.iconsetDir,
            withIntermediateDirectories: true,
            attributes: nil
        )
    } catch {
        print("✗ Could not create iconset directory \(flavor.iconsetDir): \(error)")
        return 1
    }

    print("  Drawing icon slices for \(flavor.icnsPath)…")
    for slot in slots {
        renderSlot(slot, into: flavor.iconsetDir, palette: flavor.palette)
    }

    // ── iconutil ──────────────────────────────────────────────────────────────
    print("  Running iconutil…")
    let iconutil = Process()
    iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
    iconutil.arguments     = ["-c", "icns", flavor.iconsetDir, "-o", flavor.icnsPath]
    do {
        try iconutil.run()
        iconutil.waitUntilExit()
    } catch {
        print("✗ iconutil launch failed: \(error)")
        return 1
    }

    if iconutil.terminationStatus == 0 {
        print("  ✓ \(flavor.icnsPath) written")
        return 0
    } else {
        print("✗ iconutil exited with status \(iconutil.terminationStatus)")
        return iconutil.terminationStatus
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

for flavor in flavors {
    let status = buildFlavor(flavor)
    if status != 0 {
        exit(status)
    }
}
