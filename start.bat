@echo off
chcp 65001 >nul
cd /d %~dp0
set PATH=C:\Program Files\nodejs;%PATH%
if not exist node_modules call npm.cmd install

rem 동영상 분석용 ffmpeg/ffprobe: PATH 나 FFMPEG_PATH 에 없으면 npm 패키지로 설치 (server.js 가 자동으로 사용)
set NEED_FF=
if not defined FFMPEG_PATH (
  where ffmpeg >nul 2>nul || if not exist node_modules\ffmpeg-static\ffmpeg.exe set NEED_FF=1
)
if not defined FFPROBE_PATH (
  where ffprobe >nul 2>nul || if not exist node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe set NEED_FF=1
)
if defined NEED_FF (
  echo ffmpeg/ffprobe 를 찾을 수 없어 설치합니다. 동영상 분석에 필요합니다...
  call npm.cmd install --no-save ffmpeg-static ffprobe-static
)

start "" http://localhost:3000
node server.js
