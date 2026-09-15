@echo off
rem ---------------------------------------------------------------
rem  Finds a Python 3 to run EasyChat with. Sets PY (and PYOPT), so
rem  callers run:   "%PY%" %PYOPT% server.py
rem
rem  Order: a copy already in this folder -> the py launcher ->
rem  python on PATH -> download a portable one into .python\
rem
rem  Nothing is installed and nothing needs administrator rights.
rem  Delete the .python folder to undo it.
rem ---------------------------------------------------------------

set "PY="
set "PYOPT="
pushd "%~dp0.."

if exist ".python\python.exe" (
  set "PY=%CD%\.python\python.exe"
  goto :done
)

rem --- the py launcher is never a Microsoft Store stub, so try it first
py -3 -c "import sys" >nul 2>&1
if not errorlevel 1 (
  set "PY=py"
  set "PYOPT=-3"
  goto :done
)

rem --- python / python3 on PATH, skipping the Store stub in WindowsApps
for %%C in (python.exe python3.exe) do (
  for /f "delims=" %%I in ('where %%C 2^>nul') do (
    if not defined PY (
      echo "%%I" | find /i "WindowsApps" >nul
      if errorlevel 1 set "PY=%%I"
    )
  )
)
if defined PY goto :done

rem --- nothing usable: fetch the portable build
echo.
echo   No Python found on this device.
echo   Downloading a portable copy into the project folder (about 11 MB).
echo   Nothing is installed - delete the .python folder to undo it.
echo.

set "ARCH=amd64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if /i "%PROCESSOR_ARCHITECTURE%"=="x86" set "ARCH=win32"
if defined PROCESSOR_ARCHITEW6432 set "ARCH=amd64"

for %%V in (3.13.7 3.12.10 3.11.9) do (
  if not exist ".python\python.exe" call :fetch %%V
)

if exist ".python\python.exe" (
  set "PY=%CD%\.python\python.exe"
  goto :done
)

echo.
echo   Could not download Python automatically.
echo.
echo   Do it by hand instead - three steps, no admin rights needed:
echo     1. On any machine, open
echo        https://www.python.org/downloads/windows/
echo     2. Under the newest release, download
echo        "Windows embeddable package (64-bit)"
echo     3. Unzip it into a folder called  .python  next to this file,
echo        so that  .python\python.exe  exists. Then run this again.
echo.
popd
exit /b 1

:fetch
set "PYURL=https://www.python.org/ftp/python/%1/python-%1-embed-%ARCH%.zip"
set "PYZIP=%TEMP%\easychat-python-%1.zip"
echo   Trying Python %1 ...

curl.exe -fsSL -o "%PYZIP%" "%PYURL%" >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri '%PYURL%' -OutFile '%PYZIP%' } catch { exit 1 }" >nul 2>&1
)
if not exist "%PYZIP%" exit /b 0

if not exist ".python" mkdir ".python"
tar.exe -xf "%PYZIP%" -C ".python" >nul 2>&1
if not exist ".python\python.exe" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Expand-Archive -Force -LiteralPath '%PYZIP%' -DestinationPath '.python' } catch { exit 1 }" >nul 2>&1
)
del "%PYZIP%" >nul 2>&1

if exist ".python\python.exe" echo   Got Python %1.
exit /b 0

:done
popd
exit /b 0
