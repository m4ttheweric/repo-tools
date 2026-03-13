/**
 * ConfirmPrompt — pure presentational y/n prompt.
 */
import React from "react";
import { Box, Text, useInput } from "ink";

export interface ConfirmPromptProps {
  message: string;
  onConfirm: (yes: boolean) => void;
}

export function ConfirmPrompt({ message, onConfirm }: ConfirmPromptProps) {
  useInput((input) => {
    if (input === "y" || input === "Y") onConfirm(true);
    else if (input === "n" || input === "N") onConfirm(false);
  });

  return (
    <Box gap={1}>
      <Text color="yellow">?</Text>
      <Text>{message}</Text>
      <Text dimColor>(y/n)</Text>
    </Box>
  );
}
