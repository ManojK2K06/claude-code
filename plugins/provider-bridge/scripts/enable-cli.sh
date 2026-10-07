# Source this file from Bash to enable provider commands in the current shell.
if [[ -z "${BASH_VERSION:-}" ]]; then
  printf '%s\n' 'This wrapper requires Bash.' >&2
  return 1
fi
if declare -F claude >/dev/null || declare -F claude-provider >/dev/null || alias claude >/dev/null 2>&1 || alias claude-provider >/dev/null 2>&1; then
  printf '%s\n' 'A Claude function or alias already exists. Use the separate provider CLI or open a fresh terminal.' >&2
  return 1
fi
_CLAUDE_PROVIDER_NODE=$(command -v node) || { printf '%s\n' 'Node.js is required.' >&2; return 1; }
_CLAUDE_PROVIDER_NATIVE=$(command -v claude) || _CLAUDE_PROVIDER_NATIVE=claude
_CLAUDE_PROVIDER_CLI="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/cli.mjs"
claude() {
  "$_CLAUDE_PROVIDER_NODE" "$_CLAUDE_PROVIDER_CLI" --wrap --native "$_CLAUDE_PROVIDER_NATIVE" "$@"
}
claude-provider() {
  "$_CLAUDE_PROVIDER_NODE" "$_CLAUDE_PROVIDER_CLI" "$@"
}
printf '%s\n' 'Provider CLI enabled for this shell. Try: claude provider --help' >&2
