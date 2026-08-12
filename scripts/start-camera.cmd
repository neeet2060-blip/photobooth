@echo off
REM Opens the booth's camera screen on this PC at boot, so a volunteer only
REM has to press the power button.
REM
REM Waits for the server first: pm2's own startup entry and this one both fire
REM at logon, and on this machine the booth server needs ~1-2 minutes to come
REM up behind Steam/OneDrive/antivirus. Launching Chrome immediately would
REM just show a connection-error page that somebody then has to notice and
REM reload by hand -- exactly the manual step this script exists to remove.
REM
REM localhost (not the Tailscale Funnel URL) is deliberate:
REM   * every captured frame stays on this machine instead of making a round
REM     trip over the venue's hotspot, and
REM   * http://localhost is a secure context, so getUserMedia works without
REM     the self-signed-certificate warning the LAN IP would trigger.

setlocal
set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe
set URL=http://localhost:3001/camera
set /a tries=0

:wait
REM /login answers 200 without a session cookie, so it is a readiness probe
REM that does not depend on being logged in yet.
curl.exe -s -o nul --max-time 3 http://localhost:3001/login
if not errorlevel 1 goto ready
set /a tries+=1
REM ~5 minutes of patience, then open anyway: a visible error page is better
REM than a silently blank screen with no clue that anything was attempted.
if %tries% GEQ 60 goto ready
timeout /t 5 /nobreak >nul
goto wait

:ready
start "" "%CHROME%" --kiosk --app=%URL%
endlocal
