; Instrument control must exit normally so DAC-zero / recording cleanup can run.
; Override electron-builder's default check, which can terminate a running process.
!macro customCheckAppRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONINFORMATION "Close ENS Wind Tunnel normally before installing, updating, or uninstalling. Setup will not close it for you."
    ${EndIf}
    SetErrorLevel 1
    Quit
  ${ElseIf} $R0 != 603
    ; 603 means no matching process. An uncertain process check must not proceed.
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Setup could not check whether ENS Wind Tunnel is running. Close the app and try again."
    ${EndIf}
    SetErrorLevel 1
    Quit
  ${EndIf}
!macroend
