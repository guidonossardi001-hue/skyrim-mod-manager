# Skyrim AE Mod Manager — Script installazione dipendenze
# Eseguire come: powershell -ExecutionPolicy Bypass -File install-node.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  Skyrim AE Mod Manager — Setup" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Verifica / Installa Node.js ──────────────────────────────────────────
function Test-NodeInstalled {
    try { $v = & node --version 2>$null; return $v -ne $null } catch { return $false }
}

if (-not (Test-NodeInstalled)) {
    Write-Host "[1/4] Node.js non trovato. Installo via winget..." -ForegroundColor Yellow

    $wingetAvail = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetAvail) {
        winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
    } else {
        Write-Host "  winget non disponibile. Scarico installer manuale..." -ForegroundColor Yellow
        $nodeUrl = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi"
        $installer = "$env:TEMP\node-installer.msi"
        Invoke-WebRequest -Uri $nodeUrl -OutFile $installer -UseBasicParsing
        Start-Process msiexec.exe -ArgumentList "/i `"$installer`" /quiet /norestart" -Wait
        Remove-Item $installer -Force -ErrorAction SilentlyContinue
    }

    # Ricarica PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH", "User")

    if (-not (Test-NodeInstalled)) {
        Write-Host ""
        Write-Host "  [ERRORE] Node.js non si e' installato correttamente." -ForegroundColor Red
        Write-Host "  Scarica manualmente da: https://nodejs.org" -ForegroundColor Red
        Write-Host ""
        Pause
        exit 1
    }
    Write-Host "  Node.js installato: $(node --version)" -ForegroundColor Green
} else {
    Write-Host "[1/4] Node.js gia' installato: $(node --version)" -ForegroundColor Green
}

# ── 2. Entra nella cartella progetto ────────────────────────────────────────
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir
Write-Host "[2/4] Cartella progetto: $scriptDir" -ForegroundColor Green

# ── 3. npm install ──────────────────────────────────────────────────────────
Write-Host "[3/4] Installo dipendenze npm..." -ForegroundColor Yellow
& npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERRORE] npm install fallito." -ForegroundColor Red
    Pause
    exit 1
}
Write-Host "  Dipendenze installate!" -ForegroundColor Green

# ── 4. Avvio in modalita' sviluppo ──────────────────────────────────────────
Write-Host "[4/4] Avvio Skyrim AE Mod Manager..." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Apri http://localhost:5173 nel browser per il preview web" -ForegroundColor Cyan
Write-Host "  Oppure attendi che si apra la finestra Electron" -ForegroundColor Cyan
Write-Host ""

& npm run electron:dev
