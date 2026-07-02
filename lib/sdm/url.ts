/**
 * Pure detection for the `rt sdm connect <arg>` positional: is this a
 * Linear-ticket deployment URL (needs resolveConnection) or a connector key
 * (looked up directly in the catalog)?
 */

export function isProbablyUrl(arg: string): boolean {
  return arg.startsWith("http://") || arg.startsWith("https://");
}
