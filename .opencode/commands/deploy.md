---
description: Refresh the global Git package and restart OpenCode
---

!`set -eu; package='opencode-playwright-interactive@git+https://github.com/mdc-git/opencode-playwright-interactive.git'; cache="${XDG_CACHE_HOME:-$HOME/.cache}/opencode/packages/git-$(printf '%s' "$package" | sha256sum | cut -d' ' -f1)"; printf 'Removing global Git package cache: %s\n' "$cache"; if [ -d "$cache" ]; then rm -rf -- "$cache"; printf 'Package cache removed.\n'; else printf 'Package cache was already absent.\n'; fi; printf 'Restarting OpenCode service...\n'; opencode2 service restart; printf 'OpenCode service status:\n'; opencode2 service status`
