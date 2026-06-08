#!/usr/bin/env bash
#
# Собирает портативный комплект тула под 32-битную Windows:
#   portable/  -> node.exe (x86) + index.js + node_modules/koffi + run.bat
#   dist/arcus-test-tool-portable-x86.zip
#
# Зачем x86: arccom.dll 32-битная, поэтому нужен 32-битный рантайм.
# Single-exe (pkg) под win-x86 собрать нельзя (yao-pkg не публикует 32-битную базу),
# поэтому используем официальный портативный node.exe рядом со скриптом.
#
# Использование:  ./build-portable.sh [NODE_VER]
#   NODE_VER — версия Node с доступной win-x86 сборкой (по умолчанию v22.22.3)

set -euo pipefail
cd "$(dirname "$0")"

NODE_VER="${1:-v22.22.3}"
ZIP="node-${NODE_VER}-win-x86.zip"
URL="https://nodejs.org/dist/${NODE_VER}/${ZIP}"
CACHE="/tmp/${ZIP}"
OUT="portable"

echo "[1/5] Проверяю зависимости (koffi)…"
[ -d node_modules/koffi ] || npm install --no-audit --no-fund

echo "[2/5] Скачиваю $ZIP (если нет в кэше)…"
[ -f "$CACHE" ] || curl -fsSL -o "$CACHE" "$URL"

echo "[3/5] Извлекаю node.exe (32-bit)…"
unzip -o -q "$CACHE" "node-${NODE_VER}-win-x86/node.exe" -d /tmp

echo "[4/5] Собираю папку $OUT…"
rm -rf "$OUT"
mkdir -p "$OUT/node_modules/koffi/build/koffi/win32_ia32"
cp "/tmp/node-${NODE_VER}-win-x86/node.exe" "$OUT/node.exe"
cp index.js "$OUT/index.js"
cp run.bat  "$OUT/run.bat"
cp node_modules/koffi/index.js node_modules/koffi/indirect.js node_modules/koffi/package.json \
   "$OUT/node_modules/koffi/"
cp node_modules/koffi/build/koffi/win32_ia32/koffi.node \
   "$OUT/node_modules/koffi/build/koffi/win32_ia32/"

echo "[5/5] Пакую zip…"
mkdir -p dist
rm -f dist/arcus-test-tool-portable-x86.zip
( cd "$OUT" && zip -q -r ../dist/arcus-test-tool-portable-x86.zip . )

echo
echo "Готово:"
echo "  - $OUT/                                  (распакованный комплект)"
echo "  - dist/arcus-test-tool-portable-x86.zip  (для переноса на Windows)"
