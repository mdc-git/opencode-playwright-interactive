---
description: Reload the local plugin in the background service and show status
---

!`set -eu; printf 'Reloading local plugin from %s...\n' "$PWD"; opencode2 service restart; printf 'OpenCode service status:\n'; opencode2 service status`
