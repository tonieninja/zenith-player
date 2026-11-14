; pilot w telefonie potrzebuje reguły zapory; profil Public też, bo Windows często tak oznacza sieć domową
; instalator działa bez admina, więc netsh idzie przez runas po zgodzie; tryb cichy (updater) nie pyta

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
  ; bez admina reguła zostaje, ale jest przypięta do exe, więc po odinstalowaniu nic nie otwiera
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${ZENITH_FW_RULE}"'
  ; stara nazwa reguły, gdy obejmowała tylko sieci prywatne
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Zenith Player (private networks)"'
!macroend
