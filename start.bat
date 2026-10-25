@echo off
cd /d %~dp0
set PATH=C:\Program Files\nodejs;%PATH%
if not exist node_modules call npm.cmd install
start "" http://localhost:3000
node server.js
