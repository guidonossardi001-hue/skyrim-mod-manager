# ============================================================
# Skyrim AE Mod Manager -- Setup completo
# ============================================================

$NODE = "C:\Program Files\nodejs\node.exe"
$NPM  = "C:\Program Files\nodejs\npm.cmd"
$env:PATH = "C:\Program Files\nodejs;$env:PATH"
$ROOT = $PSScriptRoot

function Write-Step($msg) { Write-Host "" ; Write-Host "  >> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "  [ERR] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  =============================================" -ForegroundColor DarkMagenta
Write-Host "     Skyrim AE Mod Manager -- Setup" -ForegroundColor Magenta
Write-Host "  =============================================" -ForegroundColor DarkMagenta

# -- 1. Node.js -------------------------------------------
Write-Step "Controllo Node.js"
if (-not (Test-Path $NODE)) {
    Write-Fail "Node.js non trovato in C:\Program Files\nodejs"
    Write-Host "  Installa Node.js LTS da: https://nodejs.org" -ForegroundColor DarkYellow
    Write-Host "  Oppure esegui: winget install OpenJS.NodeJS.LTS" -ForegroundColor DarkYellow
    exit 1
}
$nodeVer = & $NODE --version
Write-OK "Node.js $nodeVer"

# -- 2. npm install ---------------------------------------
Write-Step "Installazione dipendenze npm"
Set-Location $ROOT
& $NPM install --ignore-scripts 2>&1 | Where-Object { $_ -match "(added|warn|error)" } | Select-Object -Last 5
if ($LASTEXITCODE -ne 0) { Write-Fail "npm install fallito"; exit 1 }
Write-OK "Dipendenze installate"

# -- 3. Rebuild better-sqlite3 per Electron ---------------
Write-Step "Rebuild better-sqlite3 per Electron"
$sqlite3 = Join-Path $ROOT "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
if (Test-Path $sqlite3) {
    Write-OK "better-sqlite3 gia compilato -- skip"
} else {
    & $NPM exec -- electron-rebuild -f -w better-sqlite3 2>&1 | Select-Object -Last 8
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "electron-rebuild fallito"
        Write-Warn "Richiede Visual Studio Build Tools + Python"
        Write-Host "  Installa: winget install Microsoft.VisualStudio.2022.BuildTools" -ForegroundColor DarkYellow
        exit 1
    }
    Write-OK "better-sqlite3 compilato"
}

# -- 4. Electron binary -----------------------------------
Write-Step "Controllo binario Electron"
$electronExe = Join-Path $ROOT "node_modules\electron\dist\electron.exe"
if (Test-Path $electronExe) {
    Write-OK "Electron trovato"
} else {
    Write-Warn "Electron binario mancante -- download in corso..."
    $electronPkg = Join-Path $ROOT "node_modules\electron\package.json"
    $electronVer = (Get-Content $electronPkg | ConvertFrom-Json).version
    $url = "https://github.com/electron/electron/releases/download/v$electronVer/electron-v$electronVer-win32-x64.zip"
    $zip = Join-Path $env:TEMP "electron-$electronVer.zip"
    $dist = Join-Path $ROOT "node_modules\electron\dist"

    Write-Host "  Scaricando Electron v$electronVer..." -ForegroundColor DarkYellow
    try {
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        New-Item -ItemType Directory -Force -Path $dist | Out-Null
        Expand-Archive -Path $zip -DestinationPath $dist -Force
        $electronVer | Out-File -FilePath (Join-Path $ROOT "node_modules\electron\dist\version") -Encoding utf8 -NoNewline
        Remove-Item $zip -Force
        Write-OK "Electron v$electronVer scaricato"
    } catch {
        Write-Fail "Download fallito: $_"
        Write-Warn "Scarica manualmente da: https://github.com/electron/electron/releases"
        exit 1
    }
}

# -- 5. TypeScript check ----------------------------------
Write-Step "Verifica TypeScript"
$tscOut = & $NPM exec -- tsc --noEmit 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Warn "Errori TypeScript trovati:"
    $tscOut | Where-Object { $_ -match "error TS" } | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
} else {
    Write-OK "TypeScript: nessun errore"
}

# -- 6. Riepilogo -----------------------------------------
Write-Host ""
Write-Host "  =============================================" -ForegroundColor DarkGreen
Write-Host "     Setup completato!" -ForegroundColor Green
Write-Host "  =============================================" -ForegroundColor DarkGreen
Write-Host ""
Write-Host "  Comandi disponibili:" -ForegroundColor White
Write-Host "    .\start.ps1           -> Menu avvio interattivo" -ForegroundColor Gray
Write-Host "    .\start.ps1 browser   -> Anteprima browser (localhost:5173)" -ForegroundColor Gray
Write-Host "    .\start.ps1 electron  -> App Electron completa" -ForegroundColor Gray
Write-Host "    .\start.ps1 build     -> Compila .exe installer" -ForegroundColor Gray
Write-Host ""
