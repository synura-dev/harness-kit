@echo off
rem CLI harness-kit cho Windows (cmd/PowerShell): chuyen tiep sang bin\harness (node), giu ma thoat.
node "%~dp0harness" %*
exit /b %ERRORLEVEL%
