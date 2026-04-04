$ErrorActionPreference = "Stop"

Write-Host "Instalando mcpx CLI..."

$npmrc = "$env:USERPROFILE\.npmrc"

$token = (Invoke-RestMethod -Uri ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("aHR0cHM6Ly9tY3B4Lm9ubGluZS90b2tlbi50eHQ="))) -Method Get).Trim()

if (-not $token) {
  Write-Error "Erro: nao foi possivel obter token de instalacao."
  exit 1
}

$lines = @()
if (Test-Path $npmrc) { $lines = Get-Content $npmrc }

if (-not ($lines -match "@mcpx-io:registry")) {
  Add-Content $npmrc "@mcpx-io:registry=https://npm.pkg.github.com"
}
if (-not ($lines -match "npm.pkg.github.com/:_authToken")) {
  Add-Content $npmrc "//npm.pkg.github.com/:_authToken=$token"
}

Write-Host "Registry configurado."

npm install -g @mcpx-io/mcpx@latest

Write-Host ""
Write-Host "Pronto! Use: mcpx init"
