#!/usr/bin/swift
/// Sets a custom icon on a macOS app bundle using NSWorkspace.
/// Usage: swift set-app-icon.swift <icon.png> <app.path>

import AppKit

guard CommandLine.arguments.count >= 3 else {
    fputs("Usage: set-app-icon <icon.png> <path/to/App.app>\n", stderr)
    exit(1)
}

guard let img = NSImage(contentsOfFile: CommandLine.arguments[1]) else {
    fputs("Failed to load image: \(CommandLine.arguments[1])\n", stderr)
    exit(1)
}

let ok = NSWorkspace.shared.setIcon(img, forFile: CommandLine.arguments[2], options: [])
if !ok {
    fputs("NSWorkspace.setIcon returned false\n", stderr)
    exit(1)
}
