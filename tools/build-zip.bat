@echo off
chcp 65001 >nul
REM 웹스토어 업로드용 zip을 만듭니다. 더블클릭하세요.
REM 결과물: 저장소 최상위의 <저장소이름>-<버전>.zip
REM PowerShell로 먼저 시도하고, 실패하면 Python으로 넘어갑니다.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-zip.ps1"
if %ERRORLEVEL% EQU 0 goto done

echo.
echo PowerShell 빌드에 실패했습니다. Python으로 다시 시도합니다...
echo.
python "%~dp0build_zip.py"
if %ERRORLEVEL% EQU 0 goto done

echo.
echo 빌드에 실패했습니다. 위 오류 메시지를 확인해 주세요.

:done
echo.
pause
