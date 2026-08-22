/**
 * VS Code-family editor detection — shared by `rt settings extension`
 * (commands/extension.ts), the post-install best-effort extension install
 * (commands/post-install.ts), and the setup `tool.editor` row
 * (lib/setup/validators/tools.ts), so all three agree on which editors
 * count and where their CLI lives. Consolidated out of commands/extension.ts
 * per RULING R12 — editor detection is read from here, never re-forked.
 */

import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface DetectedEditor {
  name: string; // Display name (e.g. "Visual Studio Code")
  cliPath: string; // Full path to the CLI binary
  appPath: string; // Full path to the .app bundle
}

/** Known VS Code-family editors and their expected CLI binary names — scanned as .app bundles in /Applications and ~/Applications. */
export const EDITOR_PATTERNS: Array<{ appName: string; cliBinary: string; displayName: string }> = [
  { appName: "Cursor.app", cliBinary: "cursor", displayName: "Cursor" },
  { appName: "Cursor Personal.app", cliBinary: "cursor", displayName: "Cursor Personal" },
  { appName: "Visual Studio Code.app", cliBinary: "code", displayName: "Visual Studio Code" },
  { appName: "Visual Studio Code - Insiders.app", cliBinary: "code-insiders", displayName: "VS Code Insiders" },
  { appName: "VSCodium.app", cliBinary: "codium", displayName: "VSCodium" },
  { appName: "Antigravity.app", cliBinary: "antigravity", displayName: "Antigravity" },
  { appName: "Windsurf.app", cliBinary: "windsurf", displayName: "Windsurf" },
];

const APP_DIRS = ["/Applications", join(homedir(), "Applications")];

export function detectEditors(): DetectedEditor[] {
  const editors: DetectedEditor[] = [];

  for (const appDir of APP_DIRS) {
    if (!existsSync(appDir)) continue;

    let apps: string[];
    try {
      apps = readdirSync(appDir);
    } catch {
      continue;
    }

    for (const pattern of EDITOR_PATTERNS) {
      if (!apps.includes(pattern.appName)) continue;

      const appPath = join(appDir, pattern.appName);
      // VS Code-family editors store CLI in Contents/Resources/app/bin/<name>
      const cliPath = join(appPath, "Contents/Resources/app/bin", pattern.cliBinary);

      if (existsSync(cliPath)) {
        editors.push({ name: pattern.displayName, cliPath, appPath });
      }
    }
  }

  return editors;
}
