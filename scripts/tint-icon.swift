#!/usr/bin/swift
/// Generates a color-shifted variant of an app icon.
/// Usage: swift tint-icon.swift <input.png> <output.png>
///
/// Remaps the dark background to a bright pink→violet→blue→cyan gradient
/// while preserving and boosting the bright prism geometry.

import AppKit

guard CommandLine.arguments.count >= 3,
    let img = NSImage(contentsOfFile: CommandLine.arguments[1]),
    let tiff = img.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiff)
else {
    fputs("Usage: tint-icon <input.png> <output.png>\n", stderr)
    exit(1)
}

let w = bitmap.pixelsWide
let h = bitmap.pixelsHigh

for y in 0..<h {
    for x in 0..<w {
        var pixel: [Int] = [0, 0, 0, 0, 0]
        bitmap.getPixel(&pixel, atX: x, y: y)
        let r = CGFloat(pixel[0]) / 255.0
        let g = CGFloat(pixel[1]) / 255.0
        let b = CGFloat(pixel[2]) / 255.0
        let a = CGFloat(pixel[3]) / 255.0

        let lum = 0.299 * r + 0.587 * g + 0.114 * b

        let nx = CGFloat(x) / CGFloat(w)
        let ny = CGFloat(y) / CGFloat(h)
        let gradT = (nx + ny) / 2.0

        // Bright gradient: hot pink → electric violet → royal blue → vivid cyan
        let bgR: CGFloat, bgG: CGFloat, bgB: CGFloat
        if gradT < 0.33 {
            let t = gradT / 0.33
            bgR = 1.0 * (1.0 - t) + 0.60 * t
            bgG = 0.25 * (1.0 - t) + 0.25 * t
            bgB = 0.65 * (1.0 - t) + 1.0 * t
        } else if gradT < 0.66 {
            let t = (gradT - 0.33) / 0.33
            bgR = 0.60 * (1.0 - t) + 0.20 * t
            bgG = 0.25 * (1.0 - t) + 0.65 * t
            bgB = 1.0 * (1.0 - t) + 1.0 * t
        } else {
            let t = (gradT - 0.66) / 0.34
            bgR = 0.20 * (1.0 - t) + 0.10 * t
            bgG = 0.65 * (1.0 - t) + 0.95 * t
            bgB = 1.0 * (1.0 - t) + 0.85 * t
        }

        let t = min(1.0, lum / 0.22)
        let boost: CGFloat = 1.3
        let prismR = min(1.0, r * boost + 0.05)
        let prismG = min(1.0, g * boost + 0.05)
        let prismB = min(1.0, b * boost + 0.08)

        let newR = bgR * (1.0 - t) + prismR * t
        let newG = bgG * (1.0 - t) + prismG * t
        let newB = bgB * (1.0 - t) + prismB * t

        var out: [Int] = [
            Int(min(255, max(0, newR * 255))),
            Int(min(255, max(0, newG * 255))),
            Int(min(255, max(0, newB * 255))),
            Int(a * 255),
            0,
        ]
        bitmap.setPixel(&out, atX: x, y: y)
    }
}

let outImg = NSImage(size: NSSize(width: w, height: h))
outImg.addRepresentation(bitmap)
guard let outTiff = outImg.tiffRepresentation,
    let outRep = NSBitmapImageRep(data: outTiff),
    let png = outRep.representation(using: .png, properties: [:])
else {
    fputs("Failed to encode output PNG\n", stderr)
    exit(1)
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
