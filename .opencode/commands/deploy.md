---
description: Deploy local plugin changes and restart OpenCode
---

!`set -eu; cache="$HOME/.cache/opencode/packages/opencode-playwright-interactive:git+https"; printf 'Clearing local plugin cache: %s\n' "$cache"; if [ -d "$cache" ]; then rm -rf -- "$cache"; printf 'Plugin cache removed.\n'; else printf 'Plugin cache was already clear.\n'; fi; printf 'Restarting OpenCode service...\n'; opencode2 service restart; printf 'OpenCode service status:\n'; opencode2 service status`
