@echo off
REM Install the Android SDK components this project needs.
REM Calling sdkmanager straight from git-bash tends to mangle the quoting,
REM so the invocation lives here instead.
REM Note: keep this file ASCII-only and CRLF-terminated; cmd.exe mis-decodes
REM UTF-8 comments and needs CRLF line endings.
setlocal
set "JAVA_HOME=E:\Desktop\MoRead\.toolchain\jdk21"
set "SDK_ROOT=E:\Desktop\MoRead\.toolchain\sdk"
set "SDKM=%SDK_ROOT%\cmdline-tools\latest\bin\sdkmanager.bat"

if not exist "%SDKM%" (
  echo sdkmanager not found: %SDKM%
  exit /b 1
)

call "%SDKM%" --sdk_root="%SDK_ROOT%" "platform-tools" "platforms;android-35" "build-tools;35.0.0"
exit /b %ERRORLEVEL%
