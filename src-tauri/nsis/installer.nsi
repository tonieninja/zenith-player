Unicode true
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define UNINSTALLERICON "{{uninstaller_icon}}"
!define UNINSTALLERHEADERIMAGE "{{uninstaller_header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName

; Kolory Zenith: tło jak prawa krawędź paska bocznego, akcent jak --accent-2 w App.css
!define Z_BG "0C0F19"
!define Z_TEXT "E6E9F0"
!define Z_MUTED "8B93A7"
!define Z_LINE "222938"
!define Z_FIELD "151A26"
; COLORREF ma kolejność BGR: 0x00BBGGRR
!define Z_BG_REF 0x00190F0C
!define Z_LINE_REF 0x00382922
!define Z_ACCENT_REF 0x00FF8C4D
!define Z_TRACK_REF 0x0030221C

Var ZenithFwMissing
Var ZenithFwCheckbox
Var ZenithLastLabel

Name "${PRODUCTNAME}"
BrandingText "${PRODUCTNAME} ${VERSION}"
OutFile "${OUTFILE}"

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

# additional plugins
!addplugindir "${ADDITIONALPLUGINSPATH}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif

; Installer sidebar image
!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

; Enable header images for installer and uninstaller pages when either image is configured.
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!else if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!endif

; Installer header image
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_BITMAP "${HEADERIMAGE}"
!endif

; Uninstaller header image
!if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_UNBITMAP "${UNINSTALLERHEADERIMAGE}"
!endif

; Uninstaller icon
!if "${UNINSTALLERICON}" != ""
  !define MUI_UNICON "${UNINSTALLERICON}"
!endif

; Define registry key to store installer language
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

!define MUI_BGCOLOR "${Z_BG}"
!define MUI_TEXTCOLOR "${Z_TEXT}"
!define MUI_HEADERIMAGE_RIGHT
!define MUI_DIRECTORYPAGE_BGCOLOR "${Z_FIELD}"
!define MUI_DIRECTORYPAGE_TEXTCOLOR "${Z_TEXT}"
!define MUI_INSTFILESPAGE_COLORS "${Z_TEXT} ${Z_BG}"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
!define MUI_CUSTOMFUNCTION_GUIINIT ZenithGuiInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.ZenithGuiInit

; Installer pages, must be ordered as they appear
; 1. Welcome Page
!define MUI_WELCOMEPAGE_TITLE "$(zenithWelcomeTitle)"
!define MUI_WELCOMEPAGE_TEXT "$(zenithWelcomeText)"
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME

; Bez strony licencji: MIT leży w repo, a ta strona była tylko kolejnym klikiem

; 3. Install mode (if it is set to `both`)
!if "${INSTALLMODE}" == "both"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MULTIUSER_PAGE_INSTALLMODE
!endif

; 4. Custom page to ask user if he wants to reinstall/uninstall
;    only if a previous installation was detected
Var ReinstallPageCheck
Page custom PageReinstall PageLeaveReinstall
Function PageReinstall
  ; WiX zapisuje instalację pod losowym UUID, więc MSI szukamy po DisplayName i Publisher,
  ; a obcy pasujący wpis i tak trzeba potwierdzić przed odinstalowaniem
  StrCpy $0 0
  wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" wix_loop_done ; Exit loop if there is no more keys to loop on
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 0 wix_loop_done
    StrCpy $WixMode 1
    StrCpy $R6 "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1"
    Goto compare_version
  wix_loop_done:

  ; Check if there is an existing installation, if not, abort the reinstall page
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${IfThen} "$R0$R1" == "" ${|} Abort ${|}

  ; Compare this installar version with the existing installation
  ; and modify the messages presented to the user accordingly
  compare_version:
  StrCpy $R4 "$(older)"
  ${If} $WixMode = 1
    ReadRegStr $R0 HKLM "$R6" "DisplayVersion"
  ${Else}
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
  ${IfThen} $R0 == "" ${|} StrCpy $R4 "$(unknown)" ${|}

  nsis_tauri_utils::SemverCompare "${VERSION}" $R0
  Pop $R0
  ; Reinstalling the same version
  ${If} $R0 = 0
    StrCpy $R1 "$(alreadyInstalledLong)"
    StrCpy $R2 "$(addOrReinstall)"
    StrCpy $R3 "$(uninstallApp)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(chooseMaintenanceOption)"
  ; Upgrading
  ${ElseIf} $R0 = 1
    StrCpy $R1 "$(olderOrUnknownVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    StrCpy $R3 "$(dontUninstall)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ; Downgrading
  ${ElseIf} $R0 = -1
    StrCpy $R1 "$(newerVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    !if "${ALLOWDOWNGRADES}" == "true"
      StrCpy $R3 "$(dontUninstall)"
    !else
      StrCpy $R3 "$(dontUninstallDowngrade)"
    !endif
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ${Else}
    Abort
  ${EndIf}

  ; Nowsza wersja nadpisuje starą w miejscu, tak samo jak autoaktualizacja (/UPDATE)
  ${If} $R0 = 1
  ${AndIf} $WixMode <> 1
    Abort
  ${EndIf}

  ; tryb pasywny pomija stronę dopiero tutaj, bo wyżej trzeba ustalić zainstalowaną wersję i czy to downgrade
  ${If} $PassiveMode = 1
    Call PageLeaveReinstall
  ${Else}
    nsDialogs::Create 1018
    Pop $R4
    ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}
    SetCtlColors $R4 "${Z_TEXT}" "${Z_BG}"

    ${NSD_CreateLabel} 0 0 100% 24u $R1
    Pop $R1
    SetCtlColors $R1 "${Z_TEXT}" "${Z_BG}"

    ${NSD_CreateRadioButton} 30u 50u -30u 10u $R2
    Pop $R2
    ${NSD_OnClick} $R2 PageReinstallUpdateSelection
    Push $R2
    Call ZenithLabel

    ${NSD_CreateRadioButton} 30u 70u -30u 10u $R3
    Pop $R3
    Push $R3
    Call ZenithLabel
    ; Disable this radio button if downgrading and downgrades are disabled
    !if "${ALLOWDOWNGRADES}" == "false"
      ${IfThen} $R0 = -1 ${|} EnableWindow $R3 0 ${|}
    !endif
    ${NSD_OnClick} $R3 PageReinstallUpdateSelection

    ; Check the first radio button if this the first time
    ; we enter this page or if the second button wasn't
    ; selected the last time we were on this page
    ${If} $ReinstallPageCheck <> 2
      SendMessage $R2 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${Else}
      SendMessage $R3 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${EndIf}

    ${NSD_SetFocus} $R2
    nsDialogs::Show
  ${EndIf}
FunctionEnd
Function PageReinstallUpdateSelection
  ${NSD_GetState} $R2 $R1
  ${If} $R1 == ${BST_CHECKED}
    StrCpy $ReinstallPageCheck 1
  ${Else}
    StrCpy $ReinstallPageCheck 2
  ${EndIf}
FunctionEnd
Function PageLeaveReinstall
  ${NSD_GetState} $R2 $R1

  ; If migrating from Wix, always uninstall
  ${If} $WixMode = 1
    Goto reinst_uninstall
  ${EndIf}

  ; In update mode, always proceeds without uninstalling
  ${If} $UpdateMode = 1
    Goto reinst_done
  ${EndIf}

  ; $R0 holds whether same(0)/upgrading(1)/downgrading(-1) version
  ; $R1 holds the radio buttons state:
  ;   1 => first choice was selected
  ;   0 => second choice was selected
  ${If} $R0 = 0 ; Same version, proceed
    ${If} $R1 = 1              ; User chose to add/reinstall
      Goto reinst_done
    ${Else}                    ; User chose to uninstall
      Goto reinst_uninstall
    ${EndIf}
  ${ElseIf} $R0 = 1 ; Upgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${ElseIf} $R0 = -1 ; Downgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${EndIf}

  reinst_uninstall:
    HideWindow
    ClearErrors

    ${If} $WixMode = 1
      ReadRegStr $R1 HKLM "$R6" "UninstallString"
      ExecWait '$R1' $0
    ${Else}
      ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
      ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
      ${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE" ${|} ; append /UPDATE
      ${IfThen} $PassiveMode = 1 ${|} StrCpy $R1 "$R1 /P" ${|} ; append /P
      StrCpy $R1 "$R1 _?=$4" ; append uninstall directory
      ExecWait '$R1' $0
    ${EndIf}

    BringToFront

    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|} ; ExecWait failed, set fake exit code

    ${If} $0 <> 0
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ; User cancelled wix uninstaller? return to select un/reinstall page
      ${If} $WixMode = 1
      ${AndIf} $0 = 1602
        Abort
      ${EndIf}

      ; User cancelled NSIS uninstaller? return to select un/reinstall page
      ${If} $0 = 1
        Abort
      ${EndIf}

      ; Other erros? show generic error message and return to select un/reinstall page
      MessageBox MB_ICONEXCLAMATION "$(unableToUninstall)"
      Abort
    ${EndIf}

    ; Przy tej samej wersji „Odinstaluj” oznacza koniec, a nie instalację od nowa
    ${If} $R0 = 0
    ${AndIf} $WixMode <> 1
      Quit
    ${EndIf}
  reinst_done:
FunctionEnd

; 5. Choose install directory page
!define MUI_PAGE_HEADER_TEXT "$(zenithDirTitle)"
!define MUI_PAGE_HEADER_SUBTEXT "$(zenithDirSubtitle)"
!define MUI_DIRECTORYPAGE_TEXT_TOP "$(zenithDirText)"
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!define MUI_PAGE_CUSTOMFUNCTION_SHOW ZenithDirShow
!insertmacro MUI_PAGE_DIRECTORY

; Folder w menu Start jest stały, osobna strona do jego wyboru była zbędnym krokiem
Var AppStartMenuFolder

; 7. Installation page
!define MUI_PAGE_CUSTOMFUNCTION_SHOW ZenithInstFilesShow
!insertmacro MUI_PAGE_INSTFILES

; 8. Finish page
!define MUI_FINISHPAGE_TITLE "$(zenithFinishTitle)"
!define MUI_FINISHPAGE_TEXT "$(zenithFinishText)"
; Use show readme button in the finish page as a button create a desktop shortcut
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(createDesktop)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut
; Show run app after installation.
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "$(zenithRun)"
!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!define MUI_PAGE_CUSTOMFUNCTION_SHOW ZenithFinishShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ZenithFinishLeave
!insertmacro MUI_PAGE_FINISH

!define ZENITH_FW_RULE "Zenith Player (local network)"

Function ZenithFinishShow
  Push $mui.FinishPage.Run
  Call ZenithLabel
  Push $mui.FinishPage.ShowReadme
  Call ZenithLabel
  ${If} $ZenithFwMissing = 1
    ; 130u to kolejny wiersz pod polami MUI (90u i 110u przy domyślnej wysokości tytułu i tekstu)
    ${NSD_CreateCheckbox} 120u 130u 195u 10u "$(zenithFirewall)"
    Pop $ZenithFwCheckbox
    SetCtlColors $ZenithFwCheckbox "${Z_TEXT}" "${Z_BG}"
    Push $ZenithFwCheckbox
    Call ZenithLabel
    ; Tarcza UAC tuż za napisem, bo dodanie reguły zapory poprosi o uprawnienia administratora
    System::Call '*(i, i, i, i) p .r1'
    System::Call 'user32::GetWindowRect(p $ZenithLastLabel, p r1)'
    System::Call 'user32::MapWindowPoints(p 0, p $mui.FinishPage, p r1, i 2)'
    System::Call '*$1(i .r2, i .r3, i .r4, i .r5)'
    System::Free $1
    System::Call 'user32::GetDpiForWindow(p $mui.FinishPage) i .r6'
    ${IfThen} $6 = 0 ${|} StrCpy $6 96 ${|}
    IntOp $7 $6 * 16
    IntOp $7 $7 / 96
    IntOp $8 $6 * 4
    IntOp $8 $8 / 96
    IntOp $2 $4 + $8
    IntOp $5 $5 - $3
    IntOp $5 $5 - $7
    IntOp $5 $5 / 2
    IntOp $3 $3 + $5
    ${NSD_CreateIcon} $2 $3 $7 $7 ""
    Pop $1
    SetCtlColors $1 "" "${Z_BG}"
    ; 32518 to IDI_SHIELD
    System::Call 'comctl32::LoadIconWithScaleDown(p 0, p 32518, i r7, i r7, *p .r8) i .r9'
    ${IfThen} $9 = 0 ${|} SendMessage $1 ${STM_SETICON} $8 0 ${|}
  ${EndIf}
FunctionEnd

Function ZenithFinishLeave
  ${If} $ZenithFwMissing = 1
    ${NSD_GetState} $ZenithFwCheckbox $0
    ${If} $0 = ${BST_CHECKED}
      ExecShellWait "runas" "$SYSDIR\netsh.exe" 'advfirewall firewall add rule name="${ZENITH_FW_RULE}" dir=in action=allow program="$INSTDIR\${MAINBINARYNAME}.exe" profile=private,public remoteip=localsubnet protocol=TCP enable=yes' SW_HIDE
    ${EndIf}
  ${EndIf}
FunctionEnd

Function RunMainBinary
  HideWindow
  ; Przez explorer.exe Zenith startuje jak ze skrótu; jako dziecko instalatora potrafi zginąć razem z nim
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\${MAINBINARYNAME}.exe"'
  StrCpy $1 0
  ${Do}
    Sleep 250
    !if "${INSTALLMODE}" == "currentUser"
      nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
    !else
      nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
    !endif
    Pop $0
    ${IfThen} $0 = 0 ${|} Return ${|}
    IntOp $1 $1 + 1
  ${LoopUntil} $1 >= 20
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  Pop $0
FunctionEnd

Function ZenithDirShow
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 "${Z_TEXT}" "${Z_BG}"
  GetDlgItem $1 $0 1006
  SetCtlColors $1 "${Z_TEXT}" "${Z_BG}"
  ; Ramka grupy z motywem ignoruje kolor tekstu i na ciemnym tle byłaby czarnym napisem
  GetDlgItem $1 $0 1020
  ShowWindow $1 ${SW_HIDE}
  GetDlgItem $1 $0 1023
  SetCtlColors $1 "${Z_MUTED}" "${Z_BG}"
  GetDlgItem $1 $0 1024
  SetCtlColors $1 "${Z_MUTED}" "${Z_BG}"
  GetDlgItem $1 $0 1019
  System::Call 'uxtheme::SetWindowTheme(p r1, w "DarkMode_CFD", p 0)'
  GetDlgItem $1 $0 1001
  System::Call 'uxtheme::SetWindowTheme(p r1, w "DarkMode_Explorer", p 0)'
FunctionEnd

!macro ZENITH_UI_FUNCTIONS UN
  Function ${UN}ZenithGuiInit
    ; Ciemny pasek tytułu: atrybut 20 od Windows 10 20H1, 19 we wcześniejszych wersjach 10
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4) i .r0'
    ${If} $0 <> 0
      System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 19, *i 1, i 4)'
    ${EndIf}
    ; Kolor paska i ramki działa od Windows 11, starsze systemy zwracają błąd i zostają przy ciemnym motywie
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i ${Z_BG_REF}, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 34, *i ${Z_LINE_REF}, i 4)'
    SetCtlColors $HWNDPARENT "${Z_TEXT}" "${Z_BG}"
    GetDlgItem $0 $HWNDPARENT 1
    System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_Explorer", p 0)'
    GetDlgItem $0 $HWNDPARENT 2
    System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_Explorer", p 0)'
    GetDlgItem $0 $HWNDPARENT 3
    System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_Explorer", p 0)'
    ; 1028 to wyszarzony cień napisu 1256, na ciemnym tle tylko by go rozmazywał
    GetDlgItem $0 $HWNDPARENT 1028
    ShowWindow $0 ${SW_HIDE}
    GetDlgItem $0 $HWNDPARENT 1256
    SetCtlColors $0 "${Z_MUTED}" "${Z_BG}"
    GetDlgItem $0 $HWNDPARENT 1035
    Call ${UN}ZenithFlatLine
    GetDlgItem $0 $HWNDPARENT 1036
    Call ${UN}ZenithFlatLine
    GetDlgItem $0 $HWNDPARENT 1045
    Call ${UN}ZenithFlatLine
  FunctionEnd

  ; Wytłaczana linia rysuje się systemową bielą, więc zamieniamy ją na zwykły pasek w kolorze Z_LINE
  Function ${UN}ZenithFlatLine
    System::Call 'user32::GetWindowLongW(p r0, i -16) i .r1'
    IntOp $1 $1 & 0xFFFFFFE0
    System::Call 'user32::SetWindowLongW(p r0, i -16, i r1)'
    SetCtlColors $0 "" "${Z_LINE}"
  FunctionEnd

  Function ${UN}ZenithInstFilesShow
    FindWindow $0 "#32770" "" $HWNDPARENT
    SetCtlColors $0 "${Z_TEXT}" "${Z_BG}"
    GetDlgItem $1 $0 1006
    SetCtlColors $1 "${Z_TEXT}" "${Z_BG}"
    ; Pasek postępu w kolorze akcentu działa tylko bez motywu systemowego i bez ramki
    GetDlgItem $1 $0 1004
    System::Call 'uxtheme::SetWindowTheme(p r1, w " ", w " ")'
    System::Call 'user32::GetWindowLongW(p r1, i -16) i .r2'
    IntOp $2 $2 & 0xFF7FFFFF
    System::Call 'user32::SetWindowLongW(p r1, i -16, i r2)'
    System::Call 'user32::SetWindowPos(p r1, p 0, i 0, i 0, i 0, i 0, i 0x37)'
    SendMessage $1 ${PBM_SETBARCOLOR} 0 ${Z_ACCENT_REF}
    SendMessage $1 ${PBM_SETBKCOLOR} 0 ${Z_TRACK_REF}
    GetDlgItem $1 $0 1016
    System::Call 'uxtheme::SetWindowTheme(p r1, w "DarkMode_Explorer", p 0)'
    GetDlgItem $1 $0 1027
    System::Call 'uxtheme::SetWindowTheme(p r1, w "DarkMode_Explorer", p 0)'
  FunctionEnd

  ; Pole z motywem ignoruje kolor tekstu (MUI #443): zostaje kwadracik, napis daje klikalna etykieta obok
  Function ${UN}ZenithLabel
    Exch $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    System::Call 'user32::GetParent(p r0) p .r1'
    System::Call '*(i, i, i, i) p .r2'
    System::Call 'user32::GetWindowRect(p r0, p r2)'
    System::Call 'user32::MapWindowPoints(p 0, p r1, p r2, i 2)'
    System::Call '*$2(i .r3, i .r4, i .r5, i .r6)'
    System::Free $2
    System::Call 'user32::GetDpiForWindow(p r0) i .r2'
    ${IfThen} $2 = 0 ${|} StrCpy $2 96 ${|}
    ; 18 px przy 96 DPI mieści sam kwadracik z marginesem
    IntOp $2 $2 * 18
    IntOp $2 $2 / 96
    IntOp $6 $6 - $4
    System::Call 'user32::SetWindowPos(p r0, p 0, i 0, i 0, i r2, i r6, i 0x16)'
    IntOp $3 $3 + $2
    IntOp $5 $5 - $3
    ${NSD_GetText} $0 $1
    ; Przycięty własny napis zostawiał kreskę przy kwadraciku, więc kontrolka zostaje bez tekstu
    SendMessage $0 ${WM_SETTEXT} 0 "STR:"
    ; Bez własnego tła kontrolka rysowała biały kwadrat pod kropką
    SetCtlColors $0 "${Z_TEXT}" "${Z_BG}"
    System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_Explorer", p 0)'
    ${NSD_CreateLabel} $3 $4 $5 $6 $1
    Pop $5
    SetCtlColors $5 "${Z_TEXT}" "${Z_BG}"
    ${NSD_AddStyle} $5 ${SS_CENTERIMAGE}
    nsDialogs::SetUserData $5 $0
    ${NSD_OnClick} $5 ${UN}ZenithLabelClick
    StrCpy $ZenithLastLabel $5
    ; Etykieta tylko na szerokość napisu, żeby klik obok nie przełączał opcji i było miejsce na tarczę UAC
    System::Call 'user32::GetDC(p r5) p .r2'
    SendMessage $5 ${WM_GETFONT} 0 0 $3
    System::Call 'gdi32::SelectObject(p r2, p r3) p .r3'
    StrLen $4 $1
    System::Call '*(i, i) p .r0'
    System::Call 'gdi32::GetTextExtentPoint32W(p r2, w r1, i r4, p r0)'
    System::Call '*$0(i .r4, i)'
    System::Free $0
    System::Call 'gdi32::SelectObject(p r2, p r3)'
    System::Call 'user32::ReleaseDC(p r5, p r2)'
    IntOp $4 $4 + 4
    System::Call 'user32::SetWindowPos(p r5, p 0, i 0, i 0, i r4, i r6, i 0x16)'
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  Function ${UN}ZenithLabelClick
    Pop $0
    nsDialogs::GetUserData $0
    Pop $0
    ; BM_CLICK zaznaczyłby też wyłączoną opcję (np. zablokowany downgrade)
    System::Call 'user32::IsWindowEnabled(p r0) i .r1'
    ${If} $1 <> 0
      SendMessage $0 ${BM_CLICK} 0 0
    ${EndIf}
  FunctionEnd
!macroend
!insertmacro ZENITH_UI_FUNCTIONS ""
!insertmacro ZENITH_UI_FUNCTIONS "un."

; Uninstaller Pages
; 1. Confirm uninstall page
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
UninstPage custom un.ConfirmShow un.ConfirmLeave
Function un.ConfirmShow
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}
  !insertmacro MUI_HEADER_TEXT "$(zenithUnTitle)" "$(zenithUnSubtitle)"
  nsDialogs::Create 1018
  Pop $0
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}
  SetCtlColors $0 "${Z_TEXT}" "${Z_BG}"
  ${NSD_CreateLabel} 0 0 100% 12u "$(zenithUnText)"
  Pop $1
  SetCtlColors $1 "${Z_TEXT}" "${Z_BG}"
  ${NSD_CreateLabel} 0 14u 100% 12u "$INSTDIR"
  Pop $1
  SetCtlColors $1 "${Z_MUTED}" "${Z_BG}"
  ${NSD_CreateCheckbox} 0 40u 100% 10u "$(deleteAppData)"
  Pop $DeleteAppDataCheckbox
  SetCtlColors $DeleteAppDataCheckbox "${Z_TEXT}" "${Z_BG}"
  Push $DeleteAppDataCheckbox
  Call un.ZenithLabel
  nsDialogs::Show
FunctionEnd
Function un.ConfirmLeave
  ${NSD_GetState} $DeleteAppDataCheckbox $DeleteAppDataCheckboxState
FunctionEnd

; 2. Uninstalling Page
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ZenithInstFilesShow
!insertmacro MUI_UNPAGE_INSTFILES

;Languages
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}

Function .onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !insertmacro SetContext

  ${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        !if "${ARCH}" == "x64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else if "${ARCH}" == "arm64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
        !endif
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else if "${INSTALLMODE}" == "currentUser"
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}


  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif
FunctionEnd


Section EarlyChecks
  ; Abort silent installer if downgrades is disabled
  !if "${ALLOWDOWNGRADES}" == "false"
  ${If} ${Silent}
    ; If downgrading
    ${If} $R0 = -1
      System::Call 'kernel32::AttachConsole(i -1)i.r0'
      ${If} $0 <> 0
        System::Call 'kernel32::GetStdHandle(i -11)i.r0'
        System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
        FileWrite $0 "$(silentDowngrades)"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  !endif

SectionEnd

Section WebView2
  ; Check if Webview2 is already installed and skip this section
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "$(webview2Downloading)"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "$(webview2DownloadSuccess)"
        ${Else}
          DetailPrint "$(webview2DownloadError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
        Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        DetailPrint "$(installingWebview2)"
        ; $6 holds the path to the webview2 installer
        ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1
        ${If} $1 = 0
          DetailPrint "$(webview2InstallSuccess)"
        ${Else}
          DetailPrint "$(webview2InstallError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
SectionEnd

Section Install
  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Copy main executable
  File "${MAINBINARYSRCPATH}"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$INSTDIR\${MAINBINARYNAME}.exe,0" "Open with ${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Remove old main binary if it doesn't match new main binary name
  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\$OldMainBinaryName"
  ${EndIf}

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create start menu shortcut
  StrCpy $AppStartMenuFolder "${STARTMENUFOLDER}"
  Call CreateOrUpdateStartMenuShortcut

  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ; Reguła zapory dla pilota z telefonu: pytamy na ostatniej stronie, tylko gdy jej jeszcze nie ma
  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode <> 1
    nsExec::ExecToStack 'netsh advfirewall firewall show rule name="${ZENITH_FW_RULE}"'
    Pop $0
    Pop $1
    ${IfThen} $0 != "0" ${|} StrCpy $ZenithFwMissing 1 ${|}
  ${EndIf}

  ; Auto close this page for passive mode
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  !insertmacro MUI_UNGETLANGUAGE

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Section Uninstall

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    StrCpy $AppStartMenuFolder "${STARTMENUFOLDER}"
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; po odinstalowaniu wpis Run uruchamiałby nieistniejący program, a przy aktualizacji autostart ma zostać
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${EndIf}

  ; Delete app data if the checkbox is selected
  ; and if not updating
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Clear the install location $INSTDIR from registry
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"

    ; Clear the install language from registry
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"

    SetShellVarContext current
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}

  nsExec::Exec 'netsh advfirewall firewall delete rule name="${ZENITH_FW_RULE}"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Zenith Player (private networks)"'
  Pop $0

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Auto close if passive mode or updating
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function RestorePreviousInstallLocation
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
  StrCmp $4 "" +2 0
    StrCpy $INSTDIR $4
FunctionEnd

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
