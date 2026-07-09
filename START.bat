@echo off
title Skyrim AE Mod Manager
SET PATH=C:\Program Files\nodejs;%PATH%
cd /d "%~dp0"

echo.
echo  Skyrim AE Mod Manager
echo  ======================
echo.
echo  [1] Anteprima Browser (localhost:5173)
echo  [2] App Electron completa
echo  [3] Esci
echo.
set /p CHOICE="  Scelta: "

if "%CHOICE%"=="1" goto BROWSER
if "%CHOICE%"=="2" goto ELECTRON
goto END

:BROWSER
echo.
echo  Avvio browser preview su http://localhost:5173
echo  Apri il browser su quella pagina...
echo  (Ctrl+C per fermare)
echo.
"C:\Program Files\nodejs\node.exe" "node_modules\vite\bin\vite.js" --config vite.browser.config.ts
goto END

:ELECTRON
echo.
echo  Avvio Electron...
powershell -ExecutionPolicy Bypass -File "%~dp0start.ps1" electron
goto END

:END
echo.
pause
