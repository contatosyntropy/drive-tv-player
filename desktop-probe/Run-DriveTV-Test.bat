@echo off
setlocal
cd /d "%~dp0"
set "LOG=%~dp0diagnostico-drive-tv.txt"
echo Executando o teste. O resultado sera salvo em:
echo %LOG%
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Run-DriveTV-Test.ps1" > "%LOG%" 2>&1
set "RESULT=%ERRORLEVEL%"
echo.
echo ============================================================
echo TESTE ENCERRADO - codigo %RESULT%
echo Relatorio salvo em: %LOG%
echo ============================================================
echo.
type "%LOG%"
echo.
echo ATENCAO: antes de compartilhar o relatorio, confira se nao ha
echo chave de API ou URL privada. Nao envie sua chave.
echo.
pause
exit /b %RESULT%
