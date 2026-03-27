#!/bin/bash

echo "Instalando mcpx CLI..."

NPMRC="$HOME/.npmrc"

# Busca token de leitura do servidor
TOKEN=$(curl -fsSL https://mcpx.online/token.txt 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "Erro: nao foi possivel obter token de instalacao."
  exit 1
fi

if ! grep -q "@mcpx-io:registry" "$NPMRC" 2>/dev/null; then
  echo "@mcpx-io:registry=https://npm.pkg.github.com" >> "$NPMRC"
fi

if ! grep -q "npm.pkg.github.com/:_authToken" "$NPMRC" 2>/dev/null; then
  echo "//npm.pkg.github.com/:_authToken=$TOKEN" >> "$NPMRC"
fi

echo "Registry configurado."

npm install -g @mcpx-io/mcpx 2>/dev/null

echo ""
echo "Pronto! Use: mcpx init"
