@echo off
REM Build the app with the toolchain bundled under .toolchain\.
REM Usage: tools\build.bat [assembleDebug|assembleRelease|clean]
setlocal
set "JAVA_HOME=E:\Desktop\MoRead\.toolchain\jdk21"
set "ANDROID_HOME=E:\Desktop\MoRead\.toolchain\sdk"
set "PATH=%JAVA_HOME%\bin;%PATH%"

if "%~1"=="" (set "TASK=assembleDebug") else (set "TASK=%~1")

cd /d "%~dp0.."
call ".toolchain\gradle\bin\gradle.bat" %TASK% --no-daemon
exit /b %ERRORLEVEL%
