# ============================================================
# Skyrim AE Mod Manager -- Script di avvio
# Uso: .\start.ps1 [browser|electron|build]
# ============================================================

param([string]$Mode = "")

$env:PATH = "C:\Program Files\nodejs;$env:PATH"
$NPM  = "C:\Program Files\nodejs\npm.cmd"
$NODE = "C:\Program Files\nodejs\node.exe"
$ROOT = $PSScriptRoot

function Write-Header {
    Clear-Host
    Write-Host ""
    Write-Host "  ==========================================" -ForegroundColor DarkMagenta
    Write-Host "     Skyrim AE Mod Manager  v1.0.0" -ForegroundColor Magenta
    Write-Host "  ==========================================" -ForegroundColor DarkMagenta
    Write-Host ""
}

function Assert-Ready {
    if (-not (Test-Path "$ROOT\node_modules\better-sqlite3\build\Release\better_sqlite3.node")) {
        Write-Host "  [ERR] Setup incompleto. Esegui prima: .\setup.ps1" -ForegroundColor Red
        exit 1
    }
    if (-not (Test-Path "$ROOT\node_modules\electron\dist\electron.exe")) {
        Write-Host "  [ERR] Electron mancante. Esegui prima: .\setup.ps1" -ForegroundColor Red
        exit 1
    }
}

function Start-Browser {
    Write-Host "  >> Avvio anteprima browser su http://localhost:5173" -ForegroundColor Cyan
    Write-Host "  (Ctrl+C per fermare)" -ForegroundColor DarkGray
    Write-Host ""
    Set-Location $ROOT
    & $NODE "$ROOT\node_modules\vite\bin\vite.js" --config vite.browser.config.ts
}

function Start-Electron {
    Assert-Ready
    Write-Host "  >> Avvio Electron dev mode..." -ForegroundColor Cyan
    Write-Host "  (Chiudi la finestra Electron per fermare)" -ForegroundColor DarkGray
    Write-Host ""
    Set-Location $ROOT

    $viteJob = Start-Job -ScriptBlock {
        param($r, $n)
        $env:PATH = "C:\Program Files\nodejs;$env:PATH"
        & $n "$r\node_modules\vite\bin\vite.js" --config "$r\vite.config.ts" --host
    } -ArgumentList $ROOT, $NODE

    Write-Host "  Attendo Vite..." -ForegroundColor DarkYellow
    $maxWait = 30
    $waited  = 0
    while ($waited -lt $maxWait) {
        try {
            $resp = Invoke-WebRequest -Uri "http://localhost:5173" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
            if ($resp.StatusCode -eq 200) { break }
        } catch {}
        Start-Sleep -Seconds 1
        $waited++
        Write-Host "  ." -NoNewline -ForegroundColor DarkGray
    }
    Write-Host ""

    if ($waited -ge $maxWait) {
        Write-Host "  [ERR] Vite non risponde. Controlla gli errori sopra." -ForegroundColor Red
        Stop-Job $viteJob; Remove-Job $viteJob
        exit 1
    }

    Write-Host "  [OK] Vite pronto -- lancio Electron" -ForegroundColor Green
    & "$ROOT\node_modules\electron\dist\electron.exe" "$ROOT"

    Stop-Job $viteJob -ErrorAction SilentlyContinue
    Remove-Job $viteJob -ErrorAction SilentlyContinue
}

function Start-Build {
    Assert-Ready
    Write-Host "  >> Build produzione in corso..." -ForegroundColor Cyan
    Write-Host ""
    Set-Location $ROOT

    Write-Host "  [1/3] Compilazione TypeScript + Vite..." -ForegroundColor DarkYellow
    & $NPM run build 2>&1 | Select-Object -Last 10
    if ($LASTEXITCODE -ne 0) { Write-Host "  [ERR] Build fallita" -ForegroundColor Red; exit 1 }

    Write-Host "  [2/3] Compilazione Electron..." -ForegroundColor DarkYellow
    & $NODE "$ROOT\node_modules\.bin\tsc" -p tsconfig.json --outDir dist-electron 2>&1 | Select-Object -Last 5

    Write-Host "  [3/3] Packaging installer .exe..." -ForegroundColor DarkYellow
    & $NPM exec -- electron-builder 2>&1 | Select-Object -Last 15
    if ($LASTEXITCODE -ne 0) { Write-Host "  [ERR] Electron-builder fallito" -ForegroundColor Red; exit 1 }

    $exePath = Get-ChildItem -Path "$ROOT\release" -Filter "*.exe" -Recurse | Select-Object -First 1
    Write-Host ""
    Write-Host "  [OK] Build completata!" -ForegroundColor Green
    if ($exePath) {
        Write-Host "  Installer: $($exePath.FullName)" -ForegroundColor White
    }
}

# -- Menu interattivo -------------------------------------
Write-Header

if (-not $Mode) {
    Write-Host "  Scegli modalita':" -ForegroundColor White
    Write-Host ""
    Write-Host "  [1] Browser preview   -> localhost:5173 (veloce, no Electron)" -ForegroundColor Gray
    Write-Host "  [2] Electron dev      -> App desktop completa con DevTools" -ForegroundColor Gray
    Write-Host "  [3] Build .exe        -> Compila installer per distribuzione" -ForegroundColor Gray
    Write-Host "  [4] Setup             -> Reinstalla dipendenze" -ForegroundColor Gray
    Write-Host "  [Q] Esci" -ForegroundColor DarkGray
    Write-Host ""
    $choice = Read-Host "  Scelta"

    switch ($choice.ToUpper()) {
        "1" { $Mode = "browser"  }
        "2" { $Mode = "electron" }
        "3" { $Mode = "build"    }
        "4" { & "$ROOT\setup.ps1"; exit 0 }
        "Q" { exit 0 }
        default { Write-Host "  Scelta non valida" -ForegroundColor Red; exit 1 }
    }
}

switch ($Mode.ToLower()) {
    "browser"  { Start-Browser  }
    "electron" { Start-Electron }
    "build"    { Start-Build    }
    default {
        Write-Host "  Uso: .\start.ps1 [browser|electron|build]" -ForegroundColor Yellow
        exit 1
    }
}
