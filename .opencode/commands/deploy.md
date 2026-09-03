---
description: Update the global Git package and verify plugin activation
---

!`set -eu; package='opencode-playwright-interactive@git+https://github.com/mdc-git/opencode-playwright-interactive.git'; printf 'Checking package updates: %s\n' "$package"; opencode2 plugin check "$package"; printf 'Updating package: %s\n' "$package"; opencode2 plugin update "$package"; printf 'Package update completed. Verify the target location with /api/plugin and /api/plugin/await-activation.'`
