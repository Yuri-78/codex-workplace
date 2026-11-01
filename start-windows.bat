@echo off
setlocal
cd /d "%~dp0"
set "ERP_PY="
py -3 -c "import sys; sys.exit(sys.version_info[:2] < (3, 12))" >nul 2>&1
if not errorlevel 1 set "ERP_PY=py -3"
if defined ERP_PY goto launch
python -c "import sys; sys.exit(sys.version_info[:2] < (3, 12))" >nul 2>&1
if not errorlevel 1 set "ERP_PY=python"
if defined ERP_PY goto launch
echo Python 3.12 or later is required.
echo Install it from https://www.python.org/downloads/windows/
echo Select "Add python.exe to PATH" during installation, then run this file again.
pause
exit /b 1
:launch
set "PYTHONUTF8=1"
%ERP_PY% try_erp.py
if not errorlevel 1 exit /b 0
echo ERP could not start. Please keep the error message above for troubleshooting.
pause
exit /b 1
