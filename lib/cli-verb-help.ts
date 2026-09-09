/** RT-114: self-dispatching leaves (agent, chat) route their own verbs, so
    the tree's leaf --help guard (rest[0] only) never sees `start --help`.
    Each such module calls this after peeling its verb token. First-token
    only, so a flag value like `--text --help` still reaches the handler. */
export function verbHelpRequested(rest: string[]): boolean {
  return rest[0] === "--help" || rest[0] === "-h";
}
