@echo off
chcp 65001 >nul
setlocal
set DIR=%~dp0

rem DSH webserver port. Override by setting DSH_PORT before running, e.g.
rem   set DSH_PORT=3080 && go.cmd
if "%DSH_PORT%"=="" set DSH_PORT=3080

rem Optional: let the script fix that profile's cordis.patch.yml (trustedHosts +
rem publicBaseUrl) so the pairing endpoint is reachable. Leave empty to skip.
rem   set DSH_PROFILE=desktop && go.cmd
set EXTRA=
if not "%DSH_PROFILE%"=="" set EXTRA=-Profile %DSH_PROFILE%

echo ================================================
echo   DSH mobile - pairing QR
echo   DSH port: %DSH_PORT%
if not "%DSH_PROFILE%"=="" echo   profile : %DSH_PROFILE%
echo ================================================
echo.
echo   [1] Same WiFi  (tcp-proxy)        -^> pair-qr-lan.png
echo   [2] Any network (cloudflared)     -^> pair-qr-tunnel.png
echo   [3] Both at once                  -^> both
echo.
set /p CH=choose [1/2/3, default 1]: 
if "%CH%"=="" set CH=1

if "%CH%"=="2" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%pair-qr.ps1" -Mode tunnel -DshPort %DSH_PORT% %EXTRA%
  goto done
)
if "%CH%"=="3" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%pair-qr.ps1" -Mode both -DshPort %DSH_PORT% %EXTRA%
  goto done
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%pair-qr.ps1" -Mode lan -DshPort %DSH_PORT% %EXTRA%

:done
echo.
echo ---- done - press any key to close ----
pause >nul
