#!/bin/zsh
# Lighting/post builder scratch runner.
# Other builders save files constantly, which makes Vite HMR reload the page mid-capture
# ("Execution context was destroyed"). Snapshot the tree to /tmp and shoot from there.
set -e
SRC=/Users/sunnymallick/sunny_personal_projects/gauntlet-test
SNAP=/tmp/lp-snap
mkdir -p "$SNAP"
rsync -a --delete --exclude node_modules --exclude shots --exclude .git "$SRC/" "$SNAP/"
[ -e "$SNAP/node_modules" ] || ln -s "$SRC/node_modules" "$SNAP/node_modules"
cd "$SNAP"
node tools/shot.mjs "$@"
