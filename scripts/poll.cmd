@echo off
rem One scheduled factory poll. Output is appended to .factory\poll.log.
cd /d "%~dp0.."
if not exist .factory mkdir .factory
call npx tsx src\cli.ts poll >> .factory\poll.log 2>&1
