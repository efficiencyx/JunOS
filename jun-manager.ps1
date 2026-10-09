#requires -Version 5.1

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'The Jun OS manager only runs on Windows.'
}

$script:PowerShellExe = @(
    (Join-Path $env:SystemRoot 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'),
    (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $script:PowerShellExe) { $script:PowerShellExe = 'powershell.exe' }

# compiled (JunOS.exe) there's no $PSScriptRoot, the folder is
# wherever the exe sits. the installer drops it in her folder,
# next to start.ps1.
$script:IsCompiled = -not $PSCommandPath -or $PSCommandPath.EndsWith('.exe', 'OrdinalIgnoreCase')
$script:Root = if ($script:IsCompiled) {
    Split-Path -Parent ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
} else {
    $PSScriptRoot
}

if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA) {
    if ($script:IsCompiled) { throw 'This build was compiled without -STA. Rebuild with tools/build-installer-exe.ps1 -Manager.' }
    Start-Process -FilePath $script:PowerShellExe -WindowStyle Hidden `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', "`"$PSCommandPath`""
    exit
}

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

# a second click on the shortcut would start a second window
# racing the first one on start.ps1. one is enough.
$script:Mutex = [Threading.Mutex]::new($false, 'Local\JunOS-Manager')
if (-not $script:Mutex.WaitOne(0)) { exit }

if (-not (Test-Path -LiteralPath (Join-Path $script:Root 'start.ps1'))) {
    [System.Windows.MessageBox]::Show(
        "start.ps1 isn't next to this program ($($script:Root)). Keep JunOS.exe inside the Jun OS folder.",
        'Jun OS', 'OK', 'Error') | Out-Null
    exit 1
}

if (-not ('JunProcessOutput' -as [type])) {
    Add-Type -TypeDefinition @'
using System.Collections.Concurrent;
using System.Diagnostics;

public sealed class JunProcessOutput
{
    public readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();

    public void Attach(Process process)
    {
        process.OutputDataReceived += OnData;
        process.ErrorDataReceived += OnData;
    }

    private void OnData(object sender, DataReceivedEventArgs args)
    {
        if (args.Data != null)
            Lines.Enqueue(args.Data);
    }
}
'@
}

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Jun OS"
        Width="620" Height="520" MinWidth="520" MinHeight="420"
        WindowStartupLocation="CenterScreen"
        Background="#111318" Foreground="#F3F4F6"
        FontFamily="Segoe UI" FontSize="14">
    <Window.Resources>
        <Style TargetType="Button">
            <Setter Property="MinWidth" Value="96" />
            <Setter Property="Padding" Value="14,8" />
            <Setter Property="Margin" Value="0,0,8,8" />
            <Setter Property="Background" Value="#2A2E38" />
            <Setter Property="Foreground" Value="#F3F4F6" />
            <Setter Property="BorderBrush" Value="#464C59" />
            <Setter Property="BorderThickness" Value="1" />
            <Setter Property="Cursor" Value="Hand" />
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="{x:Type Button}">
                        <Border x:Name="ButtonBorder" Background="{TemplateBinding Background}"
                                BorderBrush="{TemplateBinding BorderBrush}"
                                BorderThickness="{TemplateBinding BorderThickness}"
                                CornerRadius="3" Padding="{TemplateBinding Padding}">
                            <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" />
                        </Border>
                        <ControlTemplate.Triggers>
                            <Trigger Property="IsMouseOver" Value="True">
                                <Setter TargetName="ButtonBorder" Property="BorderBrush" Value="#60CDFF" />
                            </Trigger>
                            <Trigger Property="IsEnabled" Value="False">
                                <Setter TargetName="ButtonBorder" Property="Opacity" Value="0.45" />
                            </Trigger>
                        </ControlTemplate.Triggers>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
    </Window.Resources>
    <Grid Margin="24,20,24,20">
        <Grid.RowDefinitions>
            <RowDefinition Height="Auto" />
            <RowDefinition Height="Auto" />
            <RowDefinition Height="Auto" />
            <RowDefinition Height="*" />
        </Grid.RowDefinitions>
        <StackPanel>
            <TextBlock FontSize="24" FontWeight="SemiBold">
                <Run Foreground="#60CDFF">&#937;</Run><Run Text="  Jun OS" />
            </TextBlock>
            <TextBlock x:Name="FolderText" Foreground="#8D95A5" FontSize="12" Margin="0,4,0,0" TextTrimming="CharacterEllipsis" />
        </StackPanel>
        <Border Grid.Row="1" Background="#1A1D24" BorderBrush="#343945" BorderThickness="1" CornerRadius="6" Padding="16" Margin="0,16,0,16">
            <StackPanel>
                <TextBlock x:Name="StateText" FontSize="18" FontWeight="SemiBold" />
                <TextBlock x:Name="DetailText" Foreground="#AEB5C2" Margin="0,6,0,0" TextWrapping="Wrap" />
            </StackPanel>
        </Border>
        <WrapPanel Grid.Row="2">
            <Button x:Name="StartButton" Content="Start" Background="#0078D4" BorderBrush="#168CE0" />
            <Button x:Name="StopButton" Content="Stop" />
            <Button x:Name="OpenButton" Content="Open Jun OS" />
            <Button x:Name="FolderButton" Content="Open folder" />
            <Button x:Name="LogsButton" Content="Logs" />
            <Button x:Name="UpdateButton" Content="Update" />
            <Button x:Name="UninstallButton" Content="Uninstall" />
        </WrapPanel>
        <TextBox x:Name="OutputBox" Grid.Row="3" IsReadOnly="True" TextWrapping="NoWrap"
                 VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Auto"
                 FontFamily="Consolas" FontSize="12" Background="#0C0E12" Foreground="#C1C6D0"
                 BorderBrush="#343945" Padding="8" />
    </Grid>
</Window>
'@

$window = [Windows.Markup.XamlReader]::Load([Xml.XmlNodeReader]::new($xaml))
foreach ($name in 'FolderText', 'StateText', 'DetailText', 'StartButton', 'StopButton', 'OpenButton',
        'FolderButton', 'LogsButton', 'UpdateButton', 'UninstallButton', 'OutputBox') {
    Set-Variable -Name $name -Value $window.FindName($name) -Scope Script
}
$FolderText.Text = $script:Root

function Get-EnvValue([string]$key, [string]$fallback) {
    $envPath = Join-Path $script:Root '.env'
    if (Test-Path -LiteralPath $envPath) {
        $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match "^$key=" } | Select-Object -Last 1
        if ($line) {
            $value = $line.Substring($line.IndexOf('=') + 1).Trim()
            if ($value) { return $value }
        }
    }
    return $fallback
}

function Get-SiteUrl { return "https://127.0.0.1:$(Get-EnvValue 'JUN_PORT' '8080')" }

function Test-Port([int]$port) {
    $tcp = [Net.Sockets.TcpClient]::new()
    try {
        return $tcp.ConnectAsync('127.0.0.1', $port).Wait(300) -and $tcp.Connected
    } catch {
        return $false
    } finally {
        $tcp.Dispose()
    }
}

# what start.ps1 launched, straight from runtime\pids.json. cheap
# enough for a 3 s timer, spawning `start.ps1 status` that often
# would not be.
function Get-RunningServices {
    $pidFile = Join-Path $script:Root 'runtime\pids.json'
    if (-not (Test-Path -LiteralPath $pidFile)) { return @() }
    try { $pids = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json } catch { return @() }
    $running = @()
    foreach ($prop in $pids.PSObject.Properties) {
        if (Get-Process -Id $prop.Value -ErrorAction SilentlyContinue) { $running += $prop.Name }
    }
    return $running
}

$script:busy = $false
$script:brushes = [Windows.Media.BrushConverter]::new()

function Set-State([string]$text, [string]$color) {
    $StateText.Text = $text
    $StateText.Foreground = $script:brushes.ConvertFromString($color)
}

function Update-Status {
    $services = @(Get-RunningServices)
    $webUp = Test-Port ([int](Get-EnvValue 'JUN_PORT' '8080'))
    if ($script:busy) {
        Set-State 'Working...' '#FFC870'
    } elseif ($webUp) {
        Set-State 'Running' '#7BD88F'
    } elseif ($services.Count -gt 0) {
        Set-State 'Partly running' '#FFC870'
    } else {
        Set-State 'Stopped' '#AEB5C2'
    }
    $DetailText.Text = if ($services.Count -gt 0) {
        'Services: ' + ($services -join ', ') + $(if ($webUp) { "`nOpen at $(Get-SiteUrl)" } else { '' })
    } else {
        'Nothing running. Press Start to bring her up.'
    }
    $StartButton.IsEnabled = -not $script:busy
    $StopButton.IsEnabled = -not $script:busy -and ($services.Count -gt 0 -or $webUp)
    $OpenButton.IsEnabled = $webUp
    $UpdateButton.IsEnabled = -not $script:busy
    $UninstallButton.IsEnabled = -not $script:busy
}

function Add-OutputLine([string]$line) {
    $plain = [regex]::Replace($line, "$([char]27)\[[0-9;]*[A-Za-z]", '')
    $OutputBox.AppendText($plain + [Environment]::NewLine)
    $OutputBox.ScrollToEnd()
}

$script:process = $null
$script:output = $null

function Invoke-StartScript([string]$action) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $script:PowerShellExe
    $info.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $script:Root 'start.ps1')`" $action"
    $info.WorkingDirectory = $script:Root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8

    $OutputBox.Clear()
    $script:process = [Diagnostics.Process]::new()
    $script:process.StartInfo = $info
    $script:output = [JunProcessOutput]::new()
    $script:output.Attach($script:process)
    [void]$script:process.Start()
    $script:process.BeginOutputReadLine()
    $script:process.BeginErrorReadLine()
    $script:busy = $true
    Update-Status
}

# a script that asks questions (update, uninstall) gets its own
# console window, the person has to be able to answer it.
# ShellExecute because that's what opens a NEW console. without it
# the script version of this window (hidden powershell) hands the
# child its own hidden console and the questions go nowhere.
function Start-ConsoleScript([string]$file) {
    $env:JUN_DIR = $script:Root
    Start-Process -FilePath $script:PowerShellExe -WorkingDirectory $script:Root `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $script:Root $file)`""
}

function Confirm-Action([string]$text) {
    return [System.Windows.MessageBox]::Show($window, $text, 'Jun OS', 'YesNo', 'Question') -eq 'Yes'
}

$timer = [Windows.Threading.DispatcherTimer]::new()
$timer.Interval = [TimeSpan]::FromMilliseconds(200)
$script:ticks = 0
$timer.Add_Tick({
    if ($script:output) {
        $line = [string]::Empty
        while ($script:output.Lines.TryDequeue([ref]$line)) { Add-OutputLine $line; $line = [string]::Empty }
    }
    # HasExited, never a bare WaitForExit(). start.ps1's services
    # inherit its output pipe and keep it open forever, so waiting
    # for the pipe to close freezes this window. same trap as setup.
    if ($script:busy -and $script:process -and $script:process.HasExited) {
        $script:busy = $false
        if ($script:process.ExitCode -ne 0) {
            Add-OutputLine "start.ps1 exited with code $($script:process.ExitCode). The Logs button has the details."
        }
        Update-Status
    }
    $script:ticks++
    if ($script:ticks % 15 -eq 0) { Update-Status }
})

$StartButton.Add_Click({ Invoke-StartScript 'start' })
$StopButton.Add_Click({ Invoke-StartScript 'stop' })
$OpenButton.Add_Click({ Start-Process (Get-SiteUrl) })
$FolderButton.Add_Click({ Start-Process explorer.exe -ArgumentList "`"$($script:Root)`"" })
$LogsButton.Add_Click({
    $logs = Join-Path $script:Root 'runtime\logs'
    if (-not (Test-Path -LiteralPath $logs)) { $logs = $script:Root }
    Start-Process explorer.exe -ArgumentList "`"$logs`""
})
$UpdateButton.Add_Click({
    if (-not (Confirm-Action "Update Jun OS now?`n`nThe installer opens in its own window, moves her to the newest version on her release channel and restarts her. Chats and settings stay.")) { return }
    Start-ConsoleScript 'install.ps1'
})
$UninstallButton.Add_Click({
    if (-not (Confirm-Action "Uninstall Jun OS?`n`nThe uninstaller opens in its own window and asks before deleting anything. This window closes so it can remove the folder.")) { return }
    Start-ConsoleScript 'uninstall.ps1'
    $window.Close()
})

$window.Add_Closed({
    $timer.Stop()
    $script:Mutex.ReleaseMutex()
})

Update-Status
$timer.Start()
[void]$window.ShowDialog()
