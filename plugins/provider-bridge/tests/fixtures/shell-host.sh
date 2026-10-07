source "$(dirname -- "${BASH_SOURCE[0]}")/../../scripts/enable-cli.sh" || exit 1
_CLAUDE_PROVIDER_NATIVE="$_CLAUDE_PROVIDER_NODE"
printf '%s\n' 'pipeline content' | claude "$(dirname -- "${BASH_SOURCE[0]}")/fake-claude.mjs" -p 'Explain "quoted text" & literal $()' '' --fixture-exit 7
exit $?
