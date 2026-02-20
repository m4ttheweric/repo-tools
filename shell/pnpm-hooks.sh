# Wraps pnpm so that `pnpm install` automatically restores
# core.hooksPath when a .local-hooks directory exists in the repo.
# This counteracts husky's `prepare` script which resets it on every install.
pnpm() {
  command pnpm "$@"
  if [ "$1" = "install" ] || [ "$1" = "i" ]; then
    if [ -d .local-hooks ]; then
      git config core.hooksPath .local-hooks
    fi
  fi
}
