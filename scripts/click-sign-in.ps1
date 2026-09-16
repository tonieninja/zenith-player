$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ZenWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

$root = [System.Windows.Automation.AutomationElement]::RootElement
$nameCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, 'Zenith')
$zenith = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $nameCond)
if (-not $zenith) { Write-Error 'Zenith window not found' }

[ZenWin]::SetForegroundWindow([IntPtr]$zenith.Current.NativeWindowHandle)
Start-Sleep -Milliseconds 500

function Find-Button($label) {
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $label)
  return $zenith.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}

$btn = Find-Button 'Zaloguj się'
if (-not $btn) { $btn = Find-Button 'Sign in' }
if (-not $btn) { $btn = Find-Button 'Zaloguj' }

if ($btn) {
  $invoke = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $invoke.Invoke()
  Write-Host 'Clicked sign-in button'
} else {
  Write-Host 'Sign-in not found; named controls:'
  $all = $zenith.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($el in $all) {
    $n = $el.Current.Name
    if ($n -and ($n -match 'log|Zalog|Sign|Google')) { Write-Host " - $n" }
  }
}
