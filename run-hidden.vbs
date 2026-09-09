' タスクスケジューラから「ウィンドウを出さずに」起動するためのラッパー。
' config.yaml の crawl.headless を true にしてから使ってください。
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c "".venv\Scripts\python.exe"" -m yahoo_coupon_watcher run", 0, False
