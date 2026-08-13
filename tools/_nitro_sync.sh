#!/bin/zsh
# Sync the live tree into the nitrous builder's isolated snapshot.
# Everything comes from the live tree EXCEPT the vehicle blueprint/physics files, which are pinned
# to the last good commit — other builders keep those mid-migration and unbootable.
set -e
ROOT=/Users/sunnymallick/sunny_personal_projects/gauntlet-test
SNAP=/tmp/nitro-nitrous
mkdir -p $SNAP
rsync -a --delete --exclude node_modules --exclude shots "$ROOT/src/" "$SNAP/src/"
cp "$ROOT/index.html" "$ROOT/vite.config.js" "$ROOT/package.json" "$SNAP/"
mkdir -p "$SNAP/tools"
cp "$ROOT/tools/harness.mjs" "$ROOT/tools/functest.mjs" "$ROOT/tools/shot.mjs" "$ROOT/tools/_nitro_shot.mjs" "$SNAP/tools/"
[ -L "$SNAP/node_modules" ] || ln -s "$ROOT/node_modules" "$SNAP/node_modules"
cd "$ROOT"
for f in assemble.js kit.js tuner.js muscle.js suv.js supercar.js index.js handling.js physics.js; do
  git show HEAD:src/vehicles/$f > "$SNAP/src/vehicles/$f"
done
echo "snapshot synced"
