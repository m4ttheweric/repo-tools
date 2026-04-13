/** @jsxImportSource @rezi-ui/jsx */
/**
 * MOLECULE: TuiCard
 *
 * A bordered box with a title bar. The border weight and color change
 * based on whether the card is selected/focused:
 *   selected=true  → heavy border, pink color
 *   selected=false → single border, dim color
 *
 * Composed from: Rezi <box> primitive + theme colors.
 *
 * Usage:
 *   <TuiCard title=" LANE 1  ·  my-repo  ·  :3000 " selected={isSelected}>
 *     <SomeRows />
 *   </TuiCard>
 *
 * Source: commands/runner.tsx LaneCard (lines 1117-1175)
 */

import { C } from "../theme.ts";

export interface TuiCardProps {
  /** Title shown in the top border. Include spaces for padding: " My Title ". */
  title: string;
  /** Title alignment within the top border. Default "left". */
  titleAlign?: "left" | "center" | "right";
  /** Whether this card is the currently focused/selected one. Affects border weight + color. */
  selected?: boolean;
  /** Horizontal padding inside the box. Default 1. */
  px?: number;
  /** Gap between child elements. Default 0. */
  gap?: number;
  children?: any;
  /** Optional unique key for Rezi reconciliation. */
  cardKey?: string;
}

export function TuiCard({
  title,
  titleAlign = "left",
  selected = false,
  px = 1,
  gap = 0,
  children,
  cardKey,
}: TuiCardProps) {
  return (
    <box
      key={cardKey}
      title={title}
      titleAlign={titleAlign}
      border={selected ? "heavy" : "single"}
      borderStyle={{ fg: selected ? C.pink : C.dim }}
      px={px}
      gap={gap}
    >
      {children}
    </box>
  );
}
