' Runs scripts\poll.cmd without opening a console window (used by Task Scheduler).
Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run "cmd /c """ & folder & "\poll.cmd""", 0, True
