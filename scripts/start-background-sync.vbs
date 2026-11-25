' Silent background launcher for Whoami Now Playing Sync (WMI Detached Process)
Set fso = CreateObject("Scripting.FileSystemObject")

repoScript = "c:\Users\pearl\Downloads\whowho\scripts\now-playing-sync.ps1"
If fso.FileExists(repoScript) Then
    scriptPath = repoScript
Else
    scriptPath = fso.GetParentFolderName(WScript.ScriptFullName) & "\now-playing-sync.ps1"
End If

cmd = "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File " & Chr(34) & scriptPath & Chr(34)

On Error Resume Next
Set objWMIService = GetObject("winmgmts:\\.\root\cimv2:Win32_Process")
errReturn = objWMIService.Create(cmd, Null, Null, intProcessID)

If errReturn <> 0 Or Err.Number <> 0 Then
    Set WshShell = CreateObject("WScript.Shell")
    WshShell.Run cmd, 0, False
End If
