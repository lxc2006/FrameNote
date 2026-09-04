!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\FrameNote\extensions"
  ${endIf}
!macroend
