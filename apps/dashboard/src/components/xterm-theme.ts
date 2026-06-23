// Selenized dark, mapped onto xterm's 16-color ANSI palette. Shared by every
// in-browser terminal surface (process logs + interactive sessions) so they
// match each other and the rest of the dashboard's dark consoles.
export const XTERM_SELENIZED_DARK = {
  background: "#103c48",
  foreground: "#adbcbc",
  cursor: "#cad8d9",
  selectionBackground: "#2d5b69",
  black: "#184956",
  red: "#fa5750",
  green: "#75b938",
  yellow: "#dbb32d",
  blue: "#4695f7",
  magenta: "#f275be",
  cyan: "#41c7b9",
  white: "#72898f",
  brightBlack: "#2d5b69",
  brightRed: "#ff665c",
  brightGreen: "#84c747",
  brightYellow: "#ebc13d",
  brightBlue: "#58a3ff",
  brightMagenta: "#ff84cd",
  brightCyan: "#53d6c7",
  brightWhite: "#cad8d9",
} as const;
