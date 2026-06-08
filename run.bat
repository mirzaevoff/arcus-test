@echo off
setlocal

REM ARCUS test tool launcher (portable 32-bit Node, no system Node.js required)
REM Run from the folder where build-portable.sh placed node.exe + index.js + this file.

REM DLL folder (must contain arccom.dll and its dependent DLLs)
set "ARCUS_DIR=C:\Arcus2\DLL"
set "ARCUS_LIB=%ARCUS_DIR%\arccom.dll"
set "PATH=%ARCUS_DIR%;%PATH%"

REM Operation command codes (depend on ops.ini; 1 = payment, 99 = admin menu)
set "ARCUS_CMD_PURCHASE=1"
set "ARCUS_CMD_ADMIN=99"

REM Web UI port
set "PORT=3000"

REM Portable node + script live next to this .bat
set "NODE=%~dp0node.exe"
set "APP=%~dp0index.js"

REM Run from the DLL dir so Windows resolves dependent DLLs
cd /d "%ARCUS_DIR%"

echo.
echo  ARCUS test tool (portable x86)
echo  DLL:  %ARCUS_LIB%
echo  Open from another host: http://THIS-PC-IP:%PORT%
echo.

"%NODE%" "%APP%"
pause
