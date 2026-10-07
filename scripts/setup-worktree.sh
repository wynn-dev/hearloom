#!/bin/sh
# Prepare a fresh git worktree (T3 Code runs this on worktree creation; T3CODE_PROJECT_ROOT is the main
# checkout). Copies the gitignored .env files, links data/ back to the main checkout, and installs deps.
set -eu

src=${T3CODE_PROJECT_ROOT:?T3CODE_PROJECT_ROOT is not set}
[ "$src" -ef . ] && { echo "already in the main checkout; nothing to set up"; exit 0; }

# .env files at the root and up to two levels deep, never overwriting one the worktree already has.
for f in "$src"/.env "$src"/.env*.local "$src"/*/.env "$src"/*/.env*.local "$src"/*/*/.env "$src"/*/*/.env*.local; do
  [ -f "$f" ] || continue
  rel=${f#"$src"/}
  case $rel in */node_modules/*) continue ;; esac
  [ -e "$rel" ] && continue
  mkdir -p "$(dirname "$rel")"
  cp "$f" "$rel"
  echo "copied $rel"
done

# The copied .env points at the same database, so share the main checkout's data/ (models, stored audio
# objects, spool) instead of starting empty: media for existing conversations keeps resolving, and the
# ~120 MB of models aren't downloaded again.
if [ -d "$src/data" ] && [ ! -e data ]; then
  ln -s "$src/data" data
  echo "linked data -> $src/data"
fi

pnpm install --frozen-lockfile
