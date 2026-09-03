---
description: Refresh the global Git package and restart OpenCode
---

!`set -eu; package='opencode-playwright-interactive@git+https://github.com/mdc-git/opencode-playwright-interactive.git'; hash="$(printf '%s' "$package" | sha256sum | cut -d' ' -f1)"; short="$(printf '%s' "$hash" | cut -c1-12)"; root="${XDG_CACHE_HOME:-$HOME/.cache}/opencode"; legacy="$root/packages/git-$hash"; current="$root/npm/git-opencode-playwright-interactive-$short"; printf 'Removing matching Git package cache entries:\n%s\n%s\n' "$legacy" "$current"; if [ -d "$legacy" ]; then rm -rf -- "$legacy"; printf 'Removed %s\n' "$legacy"; else printf 'Already absent: %s\n' "$legacy"; fi; if [ -d "$current" ]; then rm -rf -- "$current"; printf 'Removed %s\n' "$current"; else printf 'Already absent: %s\n' "$current"; fi; printf 'Restarting OpenCode service...\n'; opencode2 service restart; printf 'OpenCode service status:\n'; opencode2 service status`
