#!/bin/zsh
set -e
cd -- "$(dirname -- "$0")"
DMD_NODE="$(command -v node || true)"
DMD_BUNDLED_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [[ -z "$DMD_NODE" ]] || ! "$DMD_NODE" -e "require('node:sqlite')" >/dev/null 2>&1; then
  DMD_NODE="$DMD_BUNDLED_NODE"
fi
if [[ ! -x "$DMD_NODE" ]] || ! "$DMD_NODE" -e "require('node:sqlite')" >/dev/null 2>&1; then
  print 'Для запуска нужен Node.js 24 LTS или новее с поддержкой node:sqlite.'
  print 'Установи его с https://nodejs.org и открой этот файл ещё раз.'
  read -r '?Нажми Enter для закрытия…'
  exit 1
fi
print 'DMD: после запуска открой http://127.0.0.1:8787'
print 'Админка: http://127.0.0.1:8787/admin'
exec "$DMD_NODE" server.mjs
