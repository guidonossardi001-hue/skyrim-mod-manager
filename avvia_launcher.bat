@echo off
REM ============================================================
REM  Skyrim AE Mod Manager - Launcher zero-sforzo
REM  Doppio click da Esplora Risorse: compila e avvia l'app.
REM
REM  Uso opzionale da terminale:
REM     avvia_launcher.bat          (build completa + avvio)
REM     avvia_launcher.bat veloce   (salta la build, avvio diretto)
REM ============================================================
setlocal
title Skyrim AE Mod Manager - Launcher
chcp 65001 >nul

REM -- 1) Posizionati SEMPRE nella cartella del progetto (quella di questo .bat)
cd /d "%~dp0"

REM -- Node nel PATH (evita ENOENT se il terminale non lo eredita)
set "PATH=C:\Program Files\nodejs;%PATH%"

echo.
echo   ==========================================
echo      Skyrim AE Mod Manager  -  Launcher
echo   ==========================================
echo.

REM -- Sanity check: siamo davvero nella cartella giusta?
if not exist "package.json" (
    echo   [ERRORE] package.json non trovato in "%~dp0".
    echo   Il file .bat deve stare nella cartella principale del progetto.
    goto :fine_errore
)

REM -- Dipendenze presenti? (primo avvio su macchina nuova)
if not exist "node_modules\" (
    echo   [SETUP] node_modules assente: installo le dipendenze...
    call npm install
    if errorlevel 1 goto :fine_errore
)

REM -- Riparazione automatica del binario Electron (caso reale gia' visto:
REM    un npm install parziale lascia dist/ o path.txt mancanti)
if not exist "node_modules\electron\dist\electron.exe" (
    echo   [SETUP] Binario Electron mancante: lo scarico...
    call node node_modules\electron\install.js
    if errorlevel 1 goto :fine_errore
)
if not exist "node_modules\electron\path.txt" (
    <nul set /p ="electron.exe" > "node_modules\electron\path.txt"
)

REM -- 2) Compilazione pulita (salta con:  avvia_launcher.bat veloce)
if /i "%~1"=="veloce" (
    echo   [SKIP] Build saltata su richiesta - uso dist/ esistente.
) else (
    echo   [BUILD] Compilazione in corso ^(tsc + vite^)...
    call npm run build
    if errorlevel 1 (
        echo.
        echo   [ERRORE] Build fallita: leggi gli errori qui sopra.
        goto :fine_errore
    )
    echo   [OK] Build completata.
)

REM -- 3) Avvio dell'app Electron reale (exe locale: niente shim PowerShell)
echo.
echo   [AVVIO] Skyrim AE Mod Manager...
echo   (questa finestra resta aperta con i log; si chiude con l'app)
echo.
"node_modules\electron\dist\electron.exe" "%~dp0."
goto :eof

:fine_errore
echo.
pause
exit /b 1
