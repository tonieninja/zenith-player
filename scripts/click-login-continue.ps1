$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$nameCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, 'Zenith')
$zenith = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $nameCond)
if (-not $zenith) { Write-Error 'Zenith window not found' }

function Find-Button($label) {
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $label)
  return $zenith.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}

$btn = Find-Button 'Zalogowano - kontynuuj'
if (-not $btn) { $btn = Find-Button 'I am signed in - continue' }
if (-not $btn) {
  $all = $zenith.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($el in $all) {
    $n = $el.Current.Name
    if ($n -and ($n -like '*kontynuuj*' -or $n -like '*continue*')) { $btn = $el; break }
  }
}

if ($btn) {
  $invoke = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $invoke.Invoke()
  Write-Host 'Clicked continue login'
} else {
  Write-Host 'Continue button not found; named controls:'
  $all = $zenith.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($el in $all) {
    $n = $el.Current.Name
    if ($n -and ($n -like '*kontynuuj*' -or $n -like '*Google*' -or $n -like '*2FA*' -or $n -like '*log*')) {
      Write-Host " - $n"
    }
  }
}
