' Silent background launcher for Whoami Now Playing Sync
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

repoScript = "c:\Users\pearl\Downloads\whowho\scripts\now-playing-sync.ps1"
If fso.FileExists(repoScript) Then
    scriptPath = repoScript
Else
    scriptPath = fso.GetParentFolderName(WScript.ScriptFullName) & "\now-playing-sync.ps1"
End If

cmd = "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File " & Chr(34) & scriptPath & Chr(34)
WshShell.Run cmd, 0, False
