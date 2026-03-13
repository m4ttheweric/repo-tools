#!/usr/bin/env bun
/**
 * Dev harness for Ink components.
 *
 * Renders components with mock data and cycles through states.
 *
 * Usage:
 *   bun run ui/dev.tsx                  (start at selector)
 *   bun run ui/dev.tsx --state healthy  (jump to dashboard state)
 *   bun run ui/dev.tsx --cycle          (auto-cycle every 2s)
 */
import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput } from "ink";
import type { TiltResource } from "@tilt-launcher/sdk";
import type { DetectedWorktree, ResolvedWorktree } from "../lib";
import { DashboardView } from "./DashboardView.tsx";
import { WorktreeSelectorView, type WorktreeSelectorItem } from "./WorktreeSelectorView.tsx";

// ── Mock data ──────────────────────────────────────────────

const mockDetected: DetectedWorktree[] = [
  { dir: "/Users/dev/myapp", branch: "feature/dashboard" },
  { dir: "/Users/dev/myapp-two", branch: "feature/auth" },
  { dir: "/Users/dev/myapp-three", branch: "main" },
];

const mockWorktrees: ResolvedWorktree[] = [
  {
    dir: "/Users/dev/myapp",
    path: "myapp",
    branch: "feature/dashboard",
    ports: { backend: 3000, frontend: 3001 },
  },
  {
    dir: "/Users/dev/myapp-two",
    path: "myapp-two",
    branch: "feature/auth",
    ports: { backend: 3010, frontend: 3011 },
  },
];

const mockProxyConfigs = new Map<string, { port: number }>([
  ["adjuster", { port: 4001 }],
  ["frontend", { port: 4002 }],
]);

function mockResource(overrides: Partial<TiltResource> & { name: string }): TiltResource {
  return {
    label: overrides.name,
    category: "services",
    type: "serve",
    resourceKind: "serve",
    runtimeStatus: "ok",
    isDisabled: false,
    ...overrides,
  };
}

// ── State presets ──────────────────────────────────────────

type StateName = "selector" | "selector-partial" | "connecting" | "pending" | "healthy" | "error" | "build-warning" | "mixed";

interface StatePreset {
  type: "selector" | "dashboard";
  selectorItems?: WorktreeSelectorItem[];
  selectorCursor?: number;
  snapshots?: Map<number, TiltResource[]>;
}

const states: Record<StateName, StatePreset> = {
  selector: {
    type: "selector",
    selectorItems: mockDetected.map((wt, i) => ({
      worktree: wt,
      label: wt.dir.split("/").pop()!,
      branch: wt.branch,
      checked: true,
    })),
    selectorCursor: 0,
  },

  "selector-partial": {
    type: "selector",
    selectorItems: mockDetected.map((wt, i) => ({
      worktree: wt,
      label: wt.dir.split("/").pop()!,
      branch: wt.branch,
      checked: i < 2,
    })),
    selectorCursor: 1,
  },

  connecting: { type: "dashboard", snapshots: new Map() },

  pending: {
    type: "dashboard",
    snapshots: new Map([
      [0, [
        mockResource({ name: "adjuster", runtimeStatus: "pending", waitingOn: ["pnpm-install"] }),
        mockResource({ name: "frontend", runtimeStatus: "pending" }),
      ]],
      [1, [
        mockResource({ name: "adjuster", runtimeStatus: "pending", waitingOn: ["db-migrations"] }),
        mockResource({ name: "frontend", runtimeStatus: "pending", waitingOn: ["pnpm-install"] }),
      ]],
    ]),
  },

  healthy: {
    type: "dashboard",
    snapshots: new Map([
      [0, [
        mockResource({ name: "adjuster", runtimeStatus: "ok" }),
        mockResource({ name: "frontend", runtimeStatus: "ok" }),
      ]],
      [1, [
        mockResource({ name: "adjuster", runtimeStatus: "ok" }),
        mockResource({ name: "frontend", runtimeStatus: "ok" }),
      ]],
    ]),
  },

  error: {
    type: "dashboard",
    snapshots: new Map([
      [0, [
        mockResource({ name: "adjuster", runtimeStatus: "error", lastBuildError: "Module not found: Cannot resolve './components/Header'" }),
        mockResource({ name: "frontend", runtimeStatus: "ok" }),
      ]],
      [1, [
        mockResource({ name: "adjuster", runtimeStatus: "ok" }),
        mockResource({ name: "frontend", runtimeStatus: "error", lastBuildError: "TypeError: Cannot read property 'map' of undefined" }),
      ]],
    ]),
  },

  "build-warning": {
    type: "dashboard",
    snapshots: new Map([
      [0, [
        mockResource({ name: "adjuster", runtimeStatus: "ok", lastBuildError: "Parcel: Failed to resolve './missing-module'" }),
        mockResource({ name: "frontend", runtimeStatus: "ok" }),
      ]],
      [1, [
        mockResource({ name: "adjuster", runtimeStatus: "ok" }),
        mockResource({ name: "frontend", runtimeStatus: "ok", lastBuildError: "Warning: unused variable 'x'" }),
      ]],
    ]),
  },

  mixed: {
    type: "dashboard",
    snapshots: new Map([
      [0, [
        mockResource({ name: "adjuster", runtimeStatus: "ok" }),
        mockResource({ name: "frontend", runtimeStatus: "pending", waitingOn: ["pnpm-install"] }),
      ]],
      [1, [
        mockResource({ name: "adjuster", runtimeStatus: "error", lastBuildError: "Build failed" }),
        mockResource({ name: "frontend", runtimeStatus: "ok", lastBuildError: "Parcel warning: unused export" }),
      ]],
    ]),
  },
};

const stateNames = Object.keys(states) as StateName[];

// ── Dev App ────────────────────────────────────────────────

function DevApp({ initialState, cycle }: { initialState: StateName; cycle: boolean }) {
  const [stateIndex, setStateIndex] = useState(stateNames.indexOf(initialState));
  const currentState = stateNames[stateIndex];
  const preset = states[currentState];

  useInput((input, key) => {
    if (input === "n" || key.rightArrow) {
      setStateIndex((i) => (i + 1) % stateNames.length);
    } else if (input === "p" || key.leftArrow) {
      setStateIndex((i) => (i - 1 + stateNames.length) % stateNames.length);
    } else if (input === "q" || key.escape) {
      process.exit(0);
    }
  });

  useEffect(() => {
    if (!cycle) return;
    const timer = setInterval(() => {
      setStateIndex((i) => (i + 1) % stateNames.length);
    }, 2000);
    return () => clearInterval(timer);
  }, [cycle]);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} gap={1}>
        <Text bold color="magenta">  ▸ dev harness</Text>
        <Text dimColor>state:</Text>
        <Text color="cyan" bold>{currentState}</Text>
        <Text dimColor>({stateIndex + 1}/{stateNames.length})</Text>
        <Text dimColor>← → to navigate, q to quit</Text>
      </Box>

      {preset.type === "selector" ? (
        <WorktreeSelectorView
          items={preset.selectorItems!}
          cursor={preset.selectorCursor ?? 0}
          submitted={false}
        />
      ) : (
        <DashboardView
          resolved={mockWorktrees}
          snapshots={preset.snapshots!}
          proxyConfigs={mockProxyConfigs}
          tiltBasePort={10350}
        />
      )}
    </Box>
  );
}

// ── CLI args ───────────────────────────────────────────────

const args = process.argv.slice(2);
const stateArg = args.find((a, i) => args[i - 1] === "--state") as StateName | undefined;
const cycle = args.includes("--cycle");
const initialState: StateName = stateArg && stateNames.includes(stateArg) ? stateArg : "selector";

render(<DevApp initialState={initialState} cycle={cycle} />);
