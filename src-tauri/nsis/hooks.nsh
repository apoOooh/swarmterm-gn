; Installer hooks (Tauri `bundle.windows.nsis.installerHooks`).
;
; Ships the terminal host (ADR 0001, SWA-82) next to the app. The app never
; runs it from here: it copies it to a version directory under the local
; app data dir first, so a running host never locks this file and an
; update can always replace it. `tauri build` builds both workspace
; binaries into the same folder, so the host sits next to the main binary.

!macro NSIS_HOOK_POSTINSTALL
  !ifndef SWARMTERM_HOST_SRC
    !searchreplace SWARMTERM_HOST_SRC "${MAINBINARYSRCPATH}" "${MAINBINARYNAME}.exe" "swarmterm-host.exe"
  !endif
  SetOutPath $INSTDIR
  File "${SWARMTERM_HOST_SRC}"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Hosts started from the app data copies keep running until their panes
  ; exit; only the shipped file goes with the app.
  Delete "$INSTDIR\swarmterm-host.exe"
!macroend
