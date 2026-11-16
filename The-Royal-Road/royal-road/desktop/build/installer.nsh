; Removing the app also removes its "start with Windows" entry.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "The Royal Road"
!macroend
