#!/usr/bin/env bash
set -euo pipefail

# Nuclear Playlist Manual Sort Plugin - Installer
# Author: Chad Longanecker

PLUGIN_ID="nuclear-playlist-manual-sort"
PLUGIN_VERSION="1.0.0"
INSTALL_DIR="${HOME}/.local/share/com.nuclearplayer/plugins/${PLUGIN_ID}/${PLUGIN_VERSION}"
PLUGINS_JSON="${HOME}/.local/share/com.nuclearplayer/plugins.json"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Installing Nuclear Playlist Manual Sort Plugin v${PLUGIN_VERSION}..."

# 1. Ensure target directory exists
mkdir -p "${INSTALL_DIR}"

# 2. Copy plugin files
cp "${SCRIPT_DIR}/package.json" "${INSTALL_DIR}/package.json"
cp "${SCRIPT_DIR}/index.js" "${INSTALL_DIR}/index.js"
cp "${SCRIPT_DIR}/README.md" "${INSTALL_DIR}/README.md"
cp "${SCRIPT_DIR}/LICENSE" "${INSTALL_DIR}/LICENSE"

# 3. Register in plugins.json if not present
if [ -f "${PLUGINS_JSON}" ]; then
  python3 -c "
import json
from datetime import datetime, timezone

p = '${PLUGINS_JSON}'
try:
    with open(p, 'r') as f:
        data = json.load(f)
except Exception:
    data = {}

key = 'plugins.${PLUGIN_ID}'
now_iso = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

data[key] = {
    'enabled': True,
    'id': '${PLUGIN_ID}',
    'installationMethod': 'store',
    'installedAt': now_iso,
    'lastUpdatedAt': now_iso,
    'originalPath': '${SCRIPT_DIR}',
    'path': '${INSTALL_DIR}',
    'version': '${PLUGIN_VERSION}',
    'warnings': []
}

with open(p, 'w') as f:
    json.dump(data, f, indent=2)
"
fi

echo "==> Installation complete!"
echo "    Plugin installed to: ${INSTALL_DIR}"
echo "    Registered in: ${PLUGINS_JSON}"
echo "    Restart Nuclear Music Player to activate the manual sort plugin."
