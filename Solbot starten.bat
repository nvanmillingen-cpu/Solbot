@echo off
rem Start de Solbot en opent het dashboard in de webbrowser.
rem Dubbelklik op dit bestand. Sluit dit venster om de bot te stoppen.
rem Crasht de bot onverwacht, dan start dit venster hem na 10 seconden opnieuw.
title Solbot
cd /d "%~dp0"

rem Poort uit .env halen (standaard 3000)
set "PORT=3000"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if /i "%%A"=="PORT" if not "%%B"=="" set "PORT=%%B"
  )
)

rem Eerste keer: dependencies installeren
if not exist "node_modules" (
  echo Dependencies installeren, even geduld...
  call npm.cmd install || goto :fout
)

rem Dashboard (opnieuw) bouwen zodat het altijd bij de code past
echo Dashboard bouwen...
call npm.cmd run build >nul || goto :fout

rem Browser openen zodra de server antwoordt (op de achtergrond, alleen de eerste keer)
start "" /b powershell -NoProfile -WindowStyle Hidden -Command ^
  "$u='http://127.0.0.1:%PORT%'; for($i=0;$i -lt 60;$i++){ try { Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process $u; exit } catch { Start-Sleep 1 } }"

:loop
echo.
echo Solbot starten op http://127.0.0.1:%PORT% ...
echo Sluit dit venster om de bot te stoppen.
echo.
call npm.cmd start
if %errorlevel%==0 goto :gestopt
echo.
echo De bot is onverwacht gestopt (foutcode %errorlevel%). Herstart over 10 seconden...
echo Sluit dit venster als je dat niet wilt.
timeout /t 10 /nobreak >nul
goto :loop

:gestopt
echo.
echo De bot is gestopt.
pause
exit /b

:fout
echo.
echo Er ging iets mis. Zie de melding hierboven.
pause
