#!/bin/sh
# Writes the full Codex app-server TypeScript bindings to .codex-types/ for reference.
# Staf keeps only the small subset it uses in src/harness/codex/protocol.ts.
set -e
cd "$(dirname "$0")/.."
rm -rf .codex-types
codex app-server generate-ts --out .codex-types
echo "Wrote .codex-types/ for $(codex --version)"
