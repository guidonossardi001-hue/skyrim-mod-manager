# ============================================================
# Skyrim AE Mod Manager -- Build installer .exe
# ============================================================

$env:PATH = "C:\Program Files\nodejs;$env:PATH"
$NPM  = "C:\Program Files\nodejs\npm.cmd"
$NODE = "C:\Program Files\nodejs\node.exe"
$ROOT = $PSScriptRoot

function Write-Step($n, $msg) {
    Write-Host ""
    Write-Host "  [$n] $msg" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "  ============================================" -ForegroundColor DarkMagenta
Write-Host "     Skyrim AE Mod Manager -- Build" -ForegroundColor Magenta
Write-Host "  ============================================" -ForegroundColor DarkMagenta

Set-Location $ROOT

foreach ($check in @(
    @{ path = "node_modules\electron\dist\electron.exe"; msg = "Electron non trovato -- esegui .\setup.ps1" },
    @{ path = "node_modules\better-sqlite3\build\Release\better_sqlite3.node"; msg = "better-sqlite3 non compilato -- esegui .\setup.ps1" }
)) {
    if (-not (Test-Path (Join-Path $ROOT $check.path))) {
        Write-Host "  [ERR] $($check.msg)" -ForegroundColor Red; exit 1
    }
}

Write-Step "1/4" "TypeScript type check"
$tscErrors = & $NPM exec -- tsc --noEmit 2>&1 | Where-Object { $_ -match "error TS" }
if ($tscErrors) {
    Write-Host "  [ERR] Errori TypeScript:" -ForegroundColor Red
    $tscErrors | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    exit 1
}
Write-Host "  [OK] Nessun errore TypeScript" -ForegroundColor Green

Write-Step "2/4" "Build frontend (Vite)"
$buildOut = & $NPM run build 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERR] Build Vite fallita" -ForegroundColor Red
    $buildOut | Select-Object -Last 15 | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    exit 1
}
Write-Host "  [OK] Frontend compilato in dist/" -ForegroundColor Green

Write-Step "3/4" "Compilazione Electron main process"
if (-not (Test-Path "$ROOT\dist-electron")) { New-Item -ItemType Directory -Path "$ROOT\dist-electron" | Out-Null }
& $NODE "$ROOT\node_modules\typescript\bin\tsc" `
    --target ES2020 --module commonjs --moduleResolution node `
    --outDir "$ROOT\dist-electron" --skipLibCheck --esModuleInterop `
    "$ROOT\electron\main.ts" "$ROOT\electron\preload.ts" `
    "$ROOT\electron\downloadManager.ts" "$ROOT\electron\backupManager.ts" "$ROOT\electron\wabbajack.ts" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "  [ERR] Compilazione electron fallita" -ForegroundColor Red; exit 1 }
Write-Host "  [OK] Electron compilato in dist-electron/" -ForegroundColor Green

Write-Step "4/4" "Packaging NSIS installer"
& $NPM exec -- electron-builder --win --x64 2>&1 | Select-Object -Last 15
if ($LASTEXITCODE -ne 0) { Write-Host "  [ERR] electron-builder fallito" -ForegroundColor Red; exit 1 }

$exe = Get-ChildItem -Path "$ROOT\release" -Filter "*.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
Write-Host ""
Write-Host "  ============================================" -ForegroundColor DarkGreen
Write-Host "     Build completata con successo!" -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor DarkGreen
if ($exe) {
    Write-Host ""
    Write-Host "  Installer: $($exe.FullName)" -ForegroundColor Yellow
    Write-Host "  Dimensione: $([math]::Round($exe.Length/1MB, 1)) MB" -ForegroundColor Gray
}
Write-Host ""
