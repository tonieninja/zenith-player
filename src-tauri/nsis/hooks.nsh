; Zenith installer hooks (tauri bundle.windows.nsis.installerHooks)
; Firewall: inbound rule for zenith-player.exe so the phone remote plugin works. It allows only
; devices on the local subnet, on private AND public profiles: lots of home networks are marked
; Public by Windows, and a private-only rule silently blocked every phone there. The remote server
; itself also refuses anything that isn't a LAN address. The installer is per-user (no admin), so
; the rule is added through an elevated netsh after the user agrees; silent installs (updater)
; never ask. The rule is removed on uninstall when possible.

!define ZENITH_FW_RULE "Zenith Player (local network)"

!macro NSIS_HOOK_POSTINSTALL
  IfSilent zenith_fw_done
  nsExec::ExecToStack 'netsh advfirewall firewall show rule name="${ZENITH_FW_RULE}"'
  Pop $0
  Pop $1
  StrCmp $0 "0" zenith_fw_done
  MessageBox MB_YESNO|MB_ICONQUESTION "$(zenithFirewallAsk)" /SD IDNO IDNO zenith_fw_done
  ExecShellWait "runas" "$SYSDIR\netsh.exe" 'advfirewall firewall add rule name="${ZENITH_FW_RULE}" dir=in action=allow program="$INSTDIR\zenith-player.exe" profile=private,public remoteip=localsubnet protocol=TCP enable=yes' SW_HIDE
  zenith_fw_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; succeeds only when the uninstaller runs elevated; otherwise the (harmless, program-bound)
  ; rules stay until removed in Windows Security
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${ZENITH_FW_RULE}"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Zenith Player (private networks)"'
!macroend
