/** Thrown by filterableSelect when the user picks the "↩ back" sentinel. */
export class BackNavigation extends Error {
  constructor() { super("back"); this.name = "BackNavigation"; }
}
