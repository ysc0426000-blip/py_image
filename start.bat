@echo off
chcp 65001 >nul
title 圖片辨識系統
echo 正在啟動圖片辨識系統伺服器...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
pause
