@echo off
title Whoami Now Playing Sync
echo ========================================================
echo   WHOAMI NOW PLAYING MULTI-STREAMING SYNC
echo   Tracks Spotify, YouTube Music, Apple Music & Browsers
echo ========================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0now-playing-sync.ps1"
pause
