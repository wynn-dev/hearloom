#!/bin/sh
# `pnpm start`: apply migrations, build the console, then run the server and worker (README, "Remote
# access"). It ends by exec-ing turbo, so a supervisor's SIGTERM (launchd, `kill`) reaches turbo, which
# stops both cleanly; pnpm doesn't pass SIGTERM on. A dead worker doesn't stop the server
# (--continue=always). Extra arguments go to turbo.
set -eu
cd "$(dirname "$0")/.."

pnpm db:migrate
pnpm --filter @hearloom/web build
exec node_modules/.bin/turbo run start worker --filter=@hearloom/server --continue=always "$@"
