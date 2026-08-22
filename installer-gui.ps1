#requires -Version 5.1

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'The Jun OS graphical installer can only run on Windows.'
}

# when this file is compiled with tools/build-installer-exe.ps1 the host process
# is JunSetup.exe, NOT powershell.exe. so MainModule is useless for "give me a
# shell to run install.ps1 in" - it would relaunch the installer inside itself.
# resolve the real powershell.exe off SystemRoot instead. Sysnative is the
# door a 32 bit process uses to reach the 64 bit System32, and it only exists
# for such a process, so try it first and fall back.
$script:PowerShellExe = @(
    (Join-Path $env:SystemRoot 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'),
    (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $script:PowerShellExe) { $script:PowerShellExe = 'powershell.exe' }

$script:IsCompiled = $PSCommandPath -and $PSCommandPath.EndsWith('.exe', 'OrdinalIgnoreCase')

# tools/build-installer-exe.ps1 rewrites the next line, and ONLY that line, to
# base64 of install.ps1. leave the marker comment and the exact assignment
# shape alone or the build stops embedding and says nothing about it.
$script:EmbeddedInstaller = '' # JUN_EMBEDDED_INSTALLER

# install.ps1 git clones the repo itself, so the exe doesn't have to carry one.
# embedding that single script is the whole difference between "double click"
# and "download the repo first".
function Resolve-InstallerScript {
    if (-not $script:EmbeddedInstaller) {
        $beside = Join-Path $PSScriptRoot 'install.ps1'
        if (-not (Test-Path -LiteralPath $beside)) {
            throw 'install.ps1 was not found beside this file. Download or clone the complete Jun repository and try again.'
        }
        return $beside
    }
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("jun-install-$PID.ps1")
    $bytes = [Convert]::FromBase64String($script:EmbeddedInstaller)
    [IO.File]::WriteAllBytes($temp, $bytes)
    $script:tempInstaller = $temp
    return $temp
}
$script:tempInstaller = $null

if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA) {
    if (-not $PSCommandPath) { throw 'Run installer-gui.ps1 from a file so it can start in STA mode.' }
    # a compiled build can't relaunch itself here, it would just spawn another
    # non-STA copy forever. ps2exe -STA is what makes this branch unreachable,
    # so an exe landing in it means the build dropped the flag.
    if ($script:IsCompiled) { throw 'This build was compiled without -STA. Rebuild with tools/build-installer-exe.ps1.' }
    $restart = [Diagnostics.ProcessStartInfo]::new()
    $restart.FileName = $script:PowerShellExe
    $restart.Arguments = "-NoProfile -ExecutionPolicy Bypass -STA -File `"$PSCommandPath`""
    $restart.UseShellExecute = $true
    $restart.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    [Diagnostics.Process]::Start($restart) | Out-Null
    exit
}

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms

# Process output callbacks run without a PowerShell runspace; WPF drains this queue on its dispatcher thread.
if (-not ('InstallerProcessOutput' -as [type])) {
    Add-Type -TypeDefinition @'
using System.Collections.Concurrent;
using System.Diagnostics;

public sealed class InstallerProcessOutput
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
        x:Name="InstallerWindow"
        Title="Jun OS Setup"
        Width="860" Height="650" MinWidth="760" MinHeight="580"
        WindowStartupLocation="CenterScreen"
        Background="#111318" Foreground="#F3F4F6"
        FontFamily="Segoe UI" FontSize="14">
    <Window.Resources>
        <Style TargetType="Button">
            <Setter Property="MinWidth" Value="92" />
            <Setter Property="Padding" Value="16,8" />
            <Setter Property="Margin" Value="8,0,0,0" />
            <Setter Property="Background" Value="#2A2E38" />
            <Setter Property="Foreground" Value="#F3F4F6" />
            <Setter Property="BorderBrush" Value="#464C59" />
            <Setter Property="BorderThickness" Value="1" />
            <Setter Property="Cursor" Value="Hand" />
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="{x:Type Button}">
                        <Border x:Name="ButtonBorder"
                                Background="{TemplateBinding Background}"
                                BorderBrush="{TemplateBinding BorderBrush}"
                                BorderThickness="{TemplateBinding BorderThickness}"
                                CornerRadius="3"
                                Padding="{TemplateBinding Padding}">
                            <ContentPresenter HorizontalAlignment="Center"
                                              VerticalAlignment="Center"
                                              RecognizesAccessKey="True" />
                        </Border>
                        <ControlTemplate.Triggers>
                            <Trigger Property="IsMouseOver" Value="True">
                                <Setter TargetName="ButtonBorder" Property="BorderBrush" Value="#60CDFF" />
                            </Trigger>
                            <Trigger Property="IsPressed" Value="True">
                                <Setter TargetName="ButtonBorder" Property="Opacity" Value="0.72" />
                            </Trigger>
                            <Trigger Property="IsEnabled" Value="False">
                                <Setter TargetName="ButtonBorder" Property="Opacity" Value="0.42" />
                                <Setter Property="Cursor" Value="Arrow" />
                            </Trigger>
                        </ControlTemplate.Triggers>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
        <Style TargetType="TextBox">
            <Setter Property="Padding" Value="8,6" />
            <Setter Property="Background" Value="#20242C" />
            <Setter Property="Foreground" Value="#F3F4F6" />
            <Setter Property="BorderBrush" Value="#464C59" />
            <Setter Property="BorderThickness" Value="1" />
            <Setter Property="CaretBrush" Value="#F3F4F6" />
            <Setter Property="SelectionBrush" Value="#0078D4" />
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="{x:Type TextBox}">
                        <Border x:Name="TextBorder"
                                Background="{TemplateBinding Background}"
                                BorderBrush="{TemplateBinding BorderBrush}"
                                BorderThickness="{TemplateBinding BorderThickness}"
                                CornerRadius="3"
                                Padding="{TemplateBinding Padding}">
                            <ScrollViewer x:Name="PART_ContentHost" />
                        </Border>
                        <ControlTemplate.Triggers>
                            <Trigger Property="IsMouseOver" Value="True">
                                <Setter TargetName="TextBorder" Property="BorderBrush" Value="#697181" />
                            </Trigger>
                            <Trigger Property="IsKeyboardFocused" Value="True">
                                <Setter TargetName="TextBorder" Property="BorderBrush" Value="#60CDFF" />
                            </Trigger>
                            <Trigger Property="IsEnabled" Value="False">
                                <Setter TargetName="TextBorder" Property="Opacity" Value="0.45" />
                            </Trigger>
                        </ControlTemplate.Triggers>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
        <Style TargetType="PasswordBox">
            <Setter Property="Padding" Value="8,6" />
            <Setter Property="Background" Value="#20242C" />
            <Setter Property="Foreground" Value="#F3F4F6" />
            <Setter Property="BorderBrush" Value="#464C59" />
            <Setter Property="BorderThickness" Value="1" />
            <Setter Property="CaretBrush" Value="#F3F4F6" />
            <Setter Property="SelectionBrush" Value="#0078D4" />
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="{x:Type PasswordBox}">
                        <Border x:Name="PasswordBorder"
                                Background="{TemplateBinding Background}"
                                BorderBrush="{TemplateBinding BorderBrush}"
                                BorderThickness="{TemplateBinding BorderThickness}"
                                CornerRadius="3"
                                Padding="{TemplateBinding Padding}">
                            <ScrollViewer x:Name="PART_ContentHost" />
                        </Border>
                        <ControlTemplate.Triggers>
                            <Trigger Property="IsMouseOver" Value="True">
                                <Setter TargetName="PasswordBorder" Property="BorderBrush" Value="#697181" />
                            </Trigger>
                            <Trigger Property="IsKeyboardFocused" Value="True">
                                <Setter TargetName="PasswordBorder" Property="BorderBrush" Value="#60CDFF" />
                            </Trigger>
                            <Trigger Property="IsEnabled" Value="False">
                                <Setter TargetName="PasswordBorder" Property="Opacity" Value="0.45" />
                            </Trigger>
                        </ControlTemplate.Triggers>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
        <Style TargetType="ComboBox">
            <Setter Property="MinHeight" Value="31" />
            <Setter Property="Padding" Value="8,5" />
            <Setter Property="Background" Value="#20242C" />
            <Setter Property="Foreground" Value="#F3F4F6" />
            <Setter Property="BorderBrush" Value="#464C59" />
            <Setter Property="BorderThickness" Value="1" />
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="{x:Type ComboBox}">
                        <Grid>
                            <Border x:Name="ComboBorder"
                                    Background="{TemplateBinding Background}"
                                    BorderBrush="{TemplateBinding BorderBrush}"
                                    BorderThickness="{TemplateBinding BorderThickness}"
                                    CornerRadius="3">
                                <Grid>
                                    <Grid.ColumnDefinitions>
                                        <ColumnDefinition Width="*" />
                                        <ColumnDefinition Width="30" />
                                    </Grid.ColumnDefinitions>
                                    <ContentPresenter Grid.Column="0"
                                                      Margin="{TemplateBinding Padding}"
                                                      VerticalAlignment="Center"
                                                      Content="{TemplateBinding SelectionBoxItem}"
                                                      ContentTemplate="{TemplateBinding SelectionBoxItemTemplate}"
                                                      ContentStringFormat="{TemplateBinding SelectionBoxItemStringFormat}"
                                                      IsHitTestVisible="False" />
                                    <Path Grid.Column="1"
                                          Width="8" Height="5"
                                          HorizontalAlignment="Center"
                                          VerticalAlignment="Center"
                                          Fill="#C1C6D0"
                                          Data="M 0 0 L 8 0 L 4 5 Z" />
                                </Grid>
                            </Border>
                            <ToggleButton Focusable="False"
                                          ClickMode="Press"
                                          IsChecked="{Binding IsDropDownOpen, Mode=TwoWay, RelativeSource={RelativeSource TemplatedParent}}">
                                <ToggleButton.Template>
                                    <ControlTemplate TargetType="{x:Type ToggleButton}">
                                        <Border Background="Transparent" />
                                    </ControlTemplate>
                                </ToggleButton.Template>
                            </ToggleButton>
                            <Popup x:Name="PART_Popup"
                                   Placement="Bottom"
                                   IsOpen="{TemplateBinding IsDropDownOpen}"
                                   AllowsTransparency="True"
                                   Focusable="False"
                                   PopupAnimation="Fade">
                                <Grid MinWidth="{Binding ActualWidth, RelativeSource={RelativeSource TemplatedParent}}"
                                      MaxHeight="{TemplateBinding MaxDropDownHeight}">
                                    <Border Background="#20242C"
                                            BorderBrush="#60CDFF"
                                            BorderThickness="1"
                                            CornerRadius="3"
                                            Padding="1">
                                        <ScrollViewer CanContentScroll="True"
                                                      VerticalScrollBarVisibility="Auto">
                                            <ItemsPresenter />
                                        </ScrollViewer>
                                    </Border>
                                </Grid>
                            </Popup>
                        </Grid>
                        <ControlTemplate.Triggers>
                            <Trigger Property="IsMouseOver" Value="True">
                                <Setter TargetName="ComboBorder" Property="BorderBrush" Value="#697181" />
                            </Trigger>
                            <Trigger Property="IsKeyboardFocusWithin" Value="True">
                                <Setter TargetName="ComboBorder" Property="BorderBrush" Value="#60CDFF" />
                            </Trigger>
                            <Trigger Property="IsDropDownOpen" Value="True">
                                <Setter TargetName="ComboBorder" Property="BorderBrush" Value="#60CDFF" />
                            </Trigger>
                            <Trigger Property="IsEnabled" Value="False">
                                <Setter TargetName="ComboBorder" Property="Opacity" Value="0.45" />
                            </Trigger>
                        </ControlTemplate.Triggers>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
        <Style TargetType="ComboBoxItem">
            <Setter Property="Padding" Value="7,5" />
            <Setter Property="Background" Value="#20242C" />
            <Setter Property="Foreground" Value="#F3F4F6" />
            <Setter Property="HorizontalContentAlignment" Value="Stretch" />
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="{x:Type ComboBoxItem}">
                        <Border x:Name="ItemBorder"
                                Background="{TemplateBinding Background}"
                                Padding="{TemplateBinding Padding}"
                                CornerRadius="2">
                            <ContentPresenter VerticalAlignment="Center" />
                        </Border>
                        <ControlTemplate.Triggers>
                            <Trigger Property="IsHighlighted" Value="True">
                                <Setter TargetName="ItemBorder" Property="Background" Value="#60CDFF" />
                                <Setter Property="Foreground" Value="#111318" />
                            </Trigger>
                            <Trigger Property="IsSelected" Value="True">
                                <Setter TargetName="ItemBorder" Property="Background" Value="#315467" />
                                <Setter Property="Foreground" Value="#F3F4F6" />
                            </Trigger>
                            <MultiTrigger>
                                <MultiTrigger.Conditions>
                                    <Condition Property="IsSelected" Value="True" />
                                    <Condition Property="IsHighlighted" Value="True" />
                                </MultiTrigger.Conditions>
                                <Setter TargetName="ItemBorder" Property="Background" Value="#60CDFF" />
                                <Setter Property="Foreground" Value="#111318" />
                            </MultiTrigger>
                        </ControlTemplate.Triggers>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
        <Style TargetType="CheckBox">
            <Setter Property="Margin" Value="0,7,0,0" />
            <Setter Property="Foreground" Value="#F3F4F6" />
            <Setter Property="Cursor" Value="Hand" />
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="{x:Type CheckBox}">
                        <Grid x:Name="CheckRoot" SnapsToDevicePixels="True">
                            <Grid.ColumnDefinitions>
                                <ColumnDefinition Width="16" />
                                <ColumnDefinition Width="*" />
                            </Grid.ColumnDefinitions>
                            <Border x:Name="CheckBorder"
                                    Width="16" Height="16"
                                    Background="#20242C"
                                    BorderBrush="#697181"
                                    BorderThickness="1"
                                    CornerRadius="2"
                                    VerticalAlignment="Center">
                                <Grid>
                                    <Path x:Name="CheckMark"
                                          Width="11" Height="8"
                                          Data="M 0 4 L 4 8 L 11 0"
                                          Stroke="#111318"
                                          StrokeThickness="2"
                                          StrokeStartLineCap="Round"
                                          StrokeEndLineCap="Round"
                                          StrokeLineJoin="Round"
                                          Visibility="Collapsed" />
                                    <Border x:Name="IndeterminateMark"
                                            Width="8" Height="2"
                                            Background="#111318"
                                            CornerRadius="1"
                                            Visibility="Collapsed" />
                                </Grid>
                            </Border>
                            <ContentPresenter Grid.Column="1"
                                              Margin="7,0,0,0"
                                              VerticalAlignment="Center"
                                              RecognizesAccessKey="True" />
                        </Grid>
                        <ControlTemplate.Triggers>
                            <Trigger Property="IsMouseOver" Value="True">
                                <Setter TargetName="CheckBorder" Property="BorderBrush" Value="#60CDFF" />
                            </Trigger>
                            <Trigger Property="IsKeyboardFocused" Value="True">
                                <Setter TargetName="CheckBorder" Property="BorderBrush" Value="#60CDFF" />
                            </Trigger>
                            <Trigger Property="IsChecked" Value="True">
                                <Setter TargetName="CheckBorder" Property="Background" Value="#60CDFF" />
                                <Setter TargetName="CheckBorder" Property="BorderBrush" Value="#60CDFF" />
                                <Setter TargetName="CheckMark" Property="Visibility" Value="Visible" />
                            </Trigger>
                            <Trigger Property="IsChecked" Value="{x:Null}">
                                <Setter TargetName="CheckBorder" Property="Background" Value="#60CDFF" />
                                <Setter TargetName="CheckBorder" Property="BorderBrush" Value="#60CDFF" />
                                <Setter TargetName="IndeterminateMark" Property="Visibility" Value="Visible" />
                            </Trigger>
                            <Trigger Property="IsEnabled" Value="False">
                                <Setter TargetName="CheckRoot" Property="Opacity" Value="0.42" />
                                <Setter Property="Cursor" Value="Arrow" />
                            </Trigger>
                        </ControlTemplate.Triggers>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
        <Style TargetType="RadioButton">
            <Setter Property="Margin" Value="0,5,24,0" />
            <Setter Property="Foreground" Value="#F3F4F6" />
        </Style>
    </Window.Resources>

    <Grid>
        <Grid.RowDefinitions>
            <RowDefinition Height="Auto" />
            <RowDefinition Height="*" />
            <RowDefinition Height="Auto" />
        </Grid.RowDefinitions>

        <Border Grid.Row="0" Background="#171A20" BorderBrush="#343945" BorderThickness="0,0,0,1" Padding="28,20">
            <Grid>
                <Grid.ColumnDefinitions>
                    <ColumnDefinition Width="*" />
                    <ColumnDefinition Width="Auto" />
                </Grid.ColumnDefinitions>
                <StackPanel>
                    <TextBlock FontSize="25" FontWeight="SemiBold">
                        <Run Foreground="#60CDFF">Ω</Run><Run Text="  Jun OS" />
                    </TextBlock>
                    <TextBlock x:Name="HeaderSubtitle" Text="Windows setup" Foreground="#AEB5C2" Margin="0,5,0,0" />
                </StackPanel>
                <TextBlock x:Name="StepText" Grid.Column="1" Foreground="#8D95A5" VerticalAlignment="Center" />
            </Grid>
        </Border>

        <Grid Grid.Row="1" Margin="30,24,30,18">
            <Grid x:Name="WelcomePage">
                <StackPanel MaxWidth="720" HorizontalAlignment="Left">
                    <TextBlock Text="Welcome" FontSize="28" FontWeight="SemiBold" />
                    <TextBlock Text="Set up Jun locally on this Windows PC. The installer will detect your hardware, download the components you select, and start the application." TextWrapping="Wrap" Foreground="#C1C6D0" Margin="0,10,0,24" />

                    <Border Background="#1A1D24" BorderBrush="#343945" BorderThickness="1" CornerRadius="6" Padding="18">
                        <StackPanel>
                            <TextBlock Text="Installation folder" FontWeight="SemiBold" />
                            <Grid Margin="0,8,0,0">
                                <Grid.ColumnDefinitions>
                                    <ColumnDefinition Width="*" />
                                    <ColumnDefinition Width="Auto" />
                                </Grid.ColumnDefinitions>
                                <TextBox x:Name="InstallLocation" VerticalContentAlignment="Center" />
                                <Button x:Name="BrowseInstallButton" Grid.Column="1" Content="Browse..." />
                            </Grid>
                            <TextBlock Text="The application, local models, settings, and chat history will live in this folder." TextWrapping="Wrap" Foreground="#8D95A5" FontSize="12" Margin="0,8,0,0" />
                        </StackPanel>
                    </Border>

                    <Border Background="#16242B" BorderBrush="#315467" BorderThickness="1" CornerRadius="6" Padding="16" Margin="0,18,0,0">
                        <TextBlock x:Name="HardwareText" TextWrapping="Wrap" Foreground="#CBEFFF" />
                    </Border>
                </StackPanel>
            </Grid>

            <Grid x:Name="OptionsPage" Visibility="Collapsed">
                <ScrollViewer VerticalScrollBarVisibility="Auto">
                    <StackPanel MaxWidth="720" HorizontalAlignment="Left">
                        <TextBlock Text="Choose your setup" FontSize="28" FontWeight="SemiBold" />
                        <TextBlock Text="Express uses hardware-aware defaults. Custom exposes providers and optional features." TextWrapping="Wrap" Foreground="#C1C6D0" Margin="0,8,0,16" />

                        <StackPanel Orientation="Horizontal">
                            <RadioButton x:Name="ExpressRadio" GroupName="Mode" Content="Express (recommended)" IsChecked="True" />
                            <RadioButton x:Name="CustomRadio" GroupName="Mode" Content="Custom" />
                        </StackPanel>

                        <Border x:Name="ExpressSummary" Background="#16242B" BorderBrush="#315467" BorderThickness="1" CornerRadius="6" Padding="18" Margin="0,16,0,0">
                            <StackPanel>
                                <TextBlock Text="Recommended setup" FontWeight="SemiBold" Foreground="#CBEFFF" />
                                <TextBlock x:Name="ExpressSummaryText" TextWrapping="Wrap" Foreground="#C1C6D0" Margin="0,8,0,0" LineHeight="22" />
                            </StackPanel>
                        </Border>

                        <Border x:Name="CustomOptions" Background="#1A1D24" BorderBrush="#343945" BorderThickness="1" CornerRadius="6" Padding="18" Margin="0,16,0,0" Visibility="Collapsed">
                            <StackPanel>
                                <TextBlock Text="AI provider" FontWeight="SemiBold" />
                                <ComboBox x:Name="ProviderCombo" Margin="0,7,0,0">
                                    <ComboBoxItem Content="Ollama — local and fully managed" Tag="ollama" IsSelected="True" />
                                    <ComboBoxItem Content="OpenRouter — cloud API" Tag="openrouter" />
                                    <ComboBoxItem Content="llama.cpp — local llama-server" Tag="llamacpp" />
                                </ComboBox>

                                <StackPanel x:Name="OpenRouterPanel" Visibility="Collapsed" Margin="0,14,0,0">
                                    <TextBlock Text="OpenRouter API key" />
                                    <PasswordBox x:Name="OpenRouterKey" Margin="0,6,0,0" />
                                    <TextBlock Text="Model ID" Margin="0,10,0,0" />
                                    <TextBox x:Name="OpenRouterModel" Text="openrouter/auto" Margin="0,6,0,0" />
                                    <TextBlock Text="Cloud inference sends chat content to OpenRouter and the selected model provider." TextWrapping="Wrap" Foreground="#FFC46B" FontSize="12" Margin="0,8,0,0" />
                                </StackPanel>

                                <StackPanel x:Name="LlamaPanel" Visibility="Collapsed" Margin="0,14,0,0">
                                    <TextBlock Text="Existing llama-server URL (optional)" />
                                    <TextBox x:Name="LlamaUrl" Margin="0,6,0,0" />
                                    <TextBlock Text="Leave empty to install and manage llama.cpp automatically." Foreground="#8D95A5" FontSize="12" Margin="0,6,0,0" />
                                </StackPanel>

                                <StackPanel x:Name="LocalModelPanel">
                                    <TextBlock Text="Local model" FontWeight="SemiBold" Margin="0,16,0,0" />
                                    <ComboBox x:Name="ModelCombo" Margin="0,7,0,0" />

                                    <CheckBox x:Name="TensorParallelCheck" Content="Use multiple NVIDIA GPUs for one model" />
                                    <TextBlock x:Name="TensorParallelHint" Text="Usually slower per token; useful when a larger model only fits across multiple cards." TextWrapping="Wrap" Foreground="#8D95A5" FontSize="12" Margin="22,3,0,0" />
                                </StackPanel>

                                <Separator Margin="0,16,0,8" Background="#343945" />
                                <CheckBox x:Name="VoiceCheck" Content="Voice conversation (TTS and speech recognition)" IsChecked="True" />
                                <CheckBox x:Name="KaraokeCheck" Content="Karaoke and singing features (adds a few GB)" IsChecked="True" Margin="22,7,0,0" />
                                <CheckBox x:Name="MtpCheck" Content="Experimental multi-token prediction" />
                                <StackPanel x:Name="MtpDepthPanel" Orientation="Horizontal" Margin="22,7,0,0" Visibility="Collapsed">
                                    <TextBlock Text="Draft depth" VerticalAlignment="Center" Margin="0,0,12,0" />
                                    <ComboBox x:Name="MtpDepthCombo" Width="210">
                                        <ComboBoxItem Content="Auto-tune (recommended)" Tag="auto" IsSelected="True" />
                                        <ComboBoxItem Content="1 token" Tag="1" />
                                        <ComboBoxItem Content="2 tokens" Tag="2" />
                                        <ComboBoxItem Content="3 tokens" Tag="3" />
                                        <ComboBoxItem Content="4 tokens" Tag="4" />
                                    </ComboBox>
                                </StackPanel>
                            </StackPanel>
                        </Border>
                    </StackPanel>
                </ScrollViewer>
            </Grid>

            <Grid x:Name="AssetsPage" Visibility="Collapsed">
                <StackPanel MaxWidth="720" HorizontalAlignment="Left">
                    <TextBlock Text="Live2D assets" FontSize="28" FontWeight="SemiBold" />
                    <TextBlock Text="Jun's original model and textures are not distributed with this project. If you own My Dystopian Robot Girlfriend, the installer can reconstruct them locally from your copy." TextWrapping="Wrap" Foreground="#C1C6D0" Margin="0,9,0,20" />

                    <CheckBox x:Name="ExtractCheck" Content="Recover Live2D assets from my game installation" FontWeight="SemiBold" />
                    <Border x:Name="AssetOptions" Background="#1A1D24" BorderBrush="#343945" BorderThickness="1" CornerRadius="6" Padding="18" Margin="0,12,0,0" Visibility="Collapsed">
                        <StackPanel>
                            <TextBlock Text="Game folder (optional)" />
                            <Grid Margin="0,7,0,0">
                                <Grid.ColumnDefinitions>
                                    <ColumnDefinition Width="*" />
                                    <ColumnDefinition Width="Auto" />
                                </Grid.ColumnDefinitions>
                                <TextBox x:Name="GameLocation" />
                                <Button x:Name="BrowseGameButton" Grid.Column="1" Content="Browse..." />
                            </Grid>
                            <TextBlock Text="Leave empty to search the usual Steam and itch.io locations automatically." Foreground="#8D95A5" FontSize="12" Margin="0,7,0,0" />
                            <CheckBox x:Name="AssetAgreement" Margin="0,16,0,0">
                                <TextBlock Text="I understand these assets are for my personal use only and must not be redistributed." TextWrapping="Wrap" />
                            </CheckBox>
                        </StackPanel>
                    </Border>

                    <Border Background="#2B2116" BorderBrush="#72552E" BorderThickness="1" CornerRadius="6" Padding="16" Margin="0,18,0,0">
                        <TextBlock Text="Recovered assets remain on this computer. They are ignored by Git and are never uploaded off this machine." TextWrapping="Wrap" Foreground="#FFD79A" />
                    </Border>
                </StackPanel>
            </Grid>

            <Grid x:Name="ReviewPage" Visibility="Collapsed">
                <StackPanel MaxWidth="720" HorizontalAlignment="Left">
                    <TextBlock Text="Ready to install" FontSize="28" FontWeight="SemiBold" />
                    <TextBlock Text="Review your choices before downloads begin." Foreground="#C1C6D0" Margin="0,8,0,16" />
                    <Border Background="#1A1D24" BorderBrush="#343945" BorderThickness="1" CornerRadius="6" Padding="18">
                        <TextBlock x:Name="ReviewText" TextWrapping="Wrap" FontFamily="Consolas" LineHeight="24" />
                    </Border>
                    <CheckBox x:Name="DependencyAgreement" Margin="0,18,0,0">
                        <TextBlock Text="Install missing machine-wide prerequisites with winget. These may include Git, Ollama or llama.cpp, Python, and the Microsoft Visual C++ runtime." TextWrapping="Wrap" MaxWidth="690" />
                    </CheckBox>
                    <TextBlock Text="Everything else stays inside the selected Jun folder and can be removed with uninstall.ps1." TextWrapping="Wrap" Foreground="#8D95A5" FontSize="12" Margin="22,8,0,0" />
                </StackPanel>
            </Grid>

            <Grid x:Name="InstallPage" Visibility="Collapsed">
                <Grid.RowDefinitions>
                    <RowDefinition Height="Auto" />
                    <RowDefinition Height="Auto" />
                    <RowDefinition Height="*" />
                    <RowDefinition Height="Auto" />
                </Grid.RowDefinitions>
                <TextBlock x:Name="InstallHeading" Text="Installing Jun OS" FontSize="28" FontWeight="SemiBold" />
                <StackPanel Grid.Row="1" Margin="0,12,0,14">
                    <TextBlock x:Name="InstallStatus" Text="Preparing installation..." Foreground="#CBEFFF" />
                    <ProgressBar x:Name="InstallProgress" Height="7" IsIndeterminate="True" Margin="0,10,0,0" Foreground="#60CDFF" />
                </StackPanel>
                <TextBox x:Name="InstallLog" Grid.Row="2" IsReadOnly="True" AcceptsReturn="True" TextWrapping="NoWrap" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Auto" FontFamily="Consolas" FontSize="12" Background="#0C0E12" />
                <StackPanel x:Name="CompletionActions" Grid.Row="3" Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,14,0,0" Visibility="Collapsed">
                    <Button x:Name="OpenFolderButton" Content="Open folder" />
                    <Button x:Name="OpenSiteButton" Content="Open Jun OS" Background="#0078D4" BorderBrush="#168CE0" />
                </StackPanel>
            </Grid>
        </Grid>

        <Border Grid.Row="2" Background="#171A20" BorderBrush="#343945" BorderThickness="0,1,0,0" Padding="22,15">
            <DockPanel LastChildFill="False">
                <Button x:Name="CancelButton" Content="Cancel" DockPanel.Dock="Right" />
                <Button x:Name="NextButton" Content="Next" DockPanel.Dock="Right" Background="#0078D4" BorderBrush="#168CE0" />
                <Button x:Name="BackButton" Content="Back" DockPanel.Dock="Right" IsEnabled="False" />
            </DockPanel>
        </Border>
    </Grid>
</Window>
'@

$reader = [System.Xml.XmlNodeReader]::new($xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)

$controlNames = @(
    'HeaderSubtitle', 'StepText', 'WelcomePage', 'OptionsPage', 'AssetsPage',
    'ReviewPage', 'InstallPage', 'InstallLocation', 'BrowseInstallButton',
    'HardwareText', 'ExpressRadio', 'CustomRadio', 'ExpressSummary', 'ExpressSummaryText',
    'CustomOptions', 'ProviderCombo',
    'OpenRouterPanel', 'OpenRouterKey', 'OpenRouterModel', 'LlamaPanel', 'LlamaUrl',
    'LocalModelPanel', 'ModelCombo', 'TensorParallelCheck', 'TensorParallelHint', 'VoiceCheck',
    'KaraokeCheck', 'MtpCheck', 'MtpDepthPanel', 'MtpDepthCombo', 'ExtractCheck',
    'AssetOptions', 'GameLocation', 'BrowseGameButton', 'AssetAgreement',
    'ReviewText', 'DependencyAgreement', 'InstallHeading', 'InstallStatus',
    'InstallProgress', 'InstallLog', 'CompletionActions', 'OpenFolderButton',
    'OpenSiteButton', 'BackButton', 'NextButton', 'CancelButton'
)
foreach ($name in $controlNames) {
    Set-Variable -Name $name -Value $window.FindName($name) -Scope Script
}

$modelChoices = @(
    @{ Label = 'Jun 12B — Q8_0, highest quality and largest'; Ref = 'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q8_0' },
    @{ Label = 'Jun 12B — Q6_K, high quality'; Ref = 'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q6_K' },
    @{ Label = 'Jun 12B — Q4_K_M'; Ref = 'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q4_K_M' },
    @{ Label = 'Jun E4B — Q8_0, balanced'; Ref = 'hf.co/efficiencyx/Jun-LoRA-v4-E4B-GGUF:Q8_0' },
    @{ Label = 'Jun E4B — Q4_K_M, balanced'; Ref = 'hf.co/efficiencyx/Jun-LoRA-v4-E4B-GGUF:Q4_K_M' },
    @{ Label = 'Jun E2B — Q6_K, lightweight'; Ref = 'hf.co/efficiencyx/Jun-LoRA-E2B-GGUF:Q6_K' },
    @{ Label = 'Jun E2B — Q4_K_M, CPU-friendly'; Ref = 'hf.co/efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M' }
)
foreach ($choice in $modelChoices) {
    $item = [System.Windows.Controls.ComboBoxItem]::new()
    $item.Content = $choice.Label
    $item.Tag = $choice.Ref
    $null = $ModelCombo.Items.Add($item)
}

$script:gpuVendor = 'cpu'
$script:gpuNames = @()
$script:gpuMemory = @()
try {
    $nvidia = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($nvidia) {
        $nvidiaRows = @(& $nvidia.Source --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null |
            Where-Object { $_ -match ',\s*\d+\s*$' })
        $script:gpuNames = @($nvidiaRows | ForEach-Object { ($_ -split ',', 2)[0].Trim() })
        $script:gpuMemory = @($nvidiaRows | ForEach-Object { [int](($_ -split ',', 2)[1].Trim()) })
        if ($script:gpuMemory.Count -gt 0) { $script:gpuVendor = 'nvidia' }
    }
} catch {
    $script:gpuVendor = 'cpu'
    $script:gpuNames = @()
    $script:gpuMemory = @()
}

if ($script:gpuVendor -eq 'cpu') {
    try {
        $amdControllers = @(Get-CimInstance Win32_VideoController -ErrorAction Stop |
            Where-Object { $_.Name -match '(?i)AMD|Radeon' })
        if ($amdControllers.Count -gt 0) {
            $script:gpuVendor = 'amd'
            $script:gpuNames = @($amdControllers | ForEach-Object { $_.Name } | Sort-Object -Unique)

            $registryMemory = @(Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Video\*\0000' -ErrorAction SilentlyContinue |
                Where-Object {
                    $adapter = [string]$_.'HardwareInformation.AdapterString'
                    $script:gpuNames -contains $adapter
                } | ForEach-Object {
                    $memory = $_.'HardwareInformation.qwMemorySize'
                    if ($memory -is [byte[]] -and $memory.Length -ge 8) {
                        [BitConverter]::ToUInt64($memory, 0)
                    } elseif ($null -ne $memory) {
                        [uint64]$memory
                    }
                } | Where-Object { $_ -gt 0 } | Sort-Object -Unique)

            if ($registryMemory.Count -gt 0) {
                $script:gpuMemory = @($registryMemory | ForEach-Object { [int]($_ / 1MB) })
            } else {
                $script:gpuMemory = @($amdControllers | Where-Object { $_.AdapterRAM -gt 0 } |
                    ForEach-Object { [int]([uint64]$_.AdapterRAM / 1MB) })
            }
        }
    } catch {}
}

function Get-RecommendedModel([bool]$allGpus) {
    if ($script:gpuMemory.Count -eq 0) {
        return 'hf.co/efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M'
    }
    $mb = if ($allGpus) {
        [int](($script:gpuMemory | Measure-Object -Sum).Sum)
    } else {
        [int](($script:gpuMemory | Measure-Object -Maximum).Maximum)
    }
    if ($mb -ge 23500) { return 'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q8_0' }
    if ($mb -ge 15500) { return 'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q6_K' }
    if ($mb -ge 11500) { return 'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q4_K_M' }
    if ($mb -ge 9500) { return 'hf.co/efficiencyx/Jun-LoRA-v4-E4B-GGUF:Q8_0' }
    if ($mb -ge 7500) { return 'hf.co/efficiencyx/Jun-LoRA-v4-E4B-GGUF:Q4_K_M' }
    if ($mb -ge 5500) { return 'hf.co/efficiencyx/Jun-LoRA-E2B-GGUF:Q6_K' }
    return 'hf.co/efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M'
}

function Select-Model([string]$modelRef) {
    foreach ($item in $ModelCombo.Items) {
        if ($item.Tag -eq $modelRef) {
            $ModelCombo.SelectedItem = $item
            return
        }
    }
    $ModelCombo.SelectedIndex = $ModelCombo.Items.Count - 1
}

$script:recommendedModel = Get-RecommendedModel $false
Select-Model $script:recommendedModel
$recommendedLabel = ($modelChoices | Where-Object { $_.Ref -eq $script:recommendedModel } | Select-Object -First 1).Label
$ExpressSummaryText.Text = "Ollama with $recommendedLabel`nVoice conversation and karaoke enabled`nMulti-token prediction on, draft depth measured after install`nLive2D asset recovery offered separately"

if ($script:gpuVendor -eq 'cpu') {
    $HardwareText.Text = 'No NVIDIA or AMD GPU was detected. The CPU-friendly Jun E2B model is recommended; local inference will still work.'
} elseif ($script:gpuVendor -eq 'amd') {
    $amdName = $script:gpuNames -join ', '
    if ($script:gpuMemory.Count -gt 0) {
        $largestMb = [int](($script:gpuMemory | Measure-Object -Maximum).Maximum)
        $HardwareText.Text = "Detected $amdName with $largestMb MB VRAM. Ollama can accelerate it through ROCm or Vulkan; a matching model has been selected."
    } else {
        $HardwareText.Text = "Detected $amdName, but Windows did not report its VRAM reliably. The CPU-friendly Jun E2B model is selected; Ollama can still use ROCm or Vulkan acceleration."
    }
} else {
    $largestMb = [int](($script:gpuMemory | Measure-Object -Maximum).Maximum)
    $gpuText = if ($script:gpuMemory.Count -eq 1) { '1 NVIDIA GPU' } else { "$($script:gpuMemory.Count) NVIDIA GPUs" }
    $HardwareText.Text = "Detected $gpuText; the largest has $largestMb MB VRAM. A matching model has been selected."
}
$TensorParallelCheck.Visibility = if ($script:gpuVendor -eq 'nvidia' -and $script:gpuMemory.Count -ge 2) { 'Visible' } else { 'Collapsed' }
$TensorParallelHint.Visibility = $TensorParallelCheck.Visibility

$defaultLocation = if (Test-Path (Join-Path $PSScriptRoot '.git')) {
    $PSScriptRoot
} else {
    Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Jun'
}
$InstallLocation.Text = $defaultLocation

function Get-SelectedTag($combo) {
    if ($null -eq $combo.SelectedItem) { return '' }
    return [string]$combo.SelectedItem.Tag
}

function Show-Message([string]$message, [string]$title = 'Jun OS Setup') {
    [System.Windows.MessageBox]::Show(
        $window,
        $message,
        $title,
        [System.Windows.MessageBoxButton]::OK,
        [System.Windows.MessageBoxImage]::Information
    ) | Out-Null
}

function Update-Mode {
    $custom = $CustomRadio.IsChecked -eq $true
    $ExpressSummary.Visibility = if ($custom) { 'Collapsed' } else { 'Visible' }
    $CustomOptions.Visibility = if ($custom) { 'Visible' } else { 'Collapsed' }
    if (-not $custom) {
        $ProviderCombo.SelectedIndex = 0
        Select-Model $script:recommendedModel
        $TensorParallelCheck.IsChecked = $false
        $VoiceCheck.IsChecked = $true
        $KaraokeCheck.IsChecked = $true
        $KaraokeCheck.Visibility = 'Visible'
        $MtpCheck.IsChecked = $true
        $MtpDepthPanel.Visibility = 'Visible'
    }
}

function Update-ProviderPanels {
    $provider = Get-SelectedTag $ProviderCombo
    $OpenRouterPanel.Visibility = if ($provider -eq 'openrouter') { 'Visible' } else { 'Collapsed' }
    $LlamaPanel.Visibility = if ($provider -eq 'llamacpp') { 'Visible' } else { 'Collapsed' }
    $managedLocal = $provider -eq 'ollama' -or ($provider -eq 'llamacpp' -and -not $LlamaUrl.Text.Trim())
    $LocalModelPanel.Visibility = if ($managedLocal) { 'Visible' } else { 'Collapsed' }
    $showTensorParallel = $managedLocal -and $script:gpuMemory.Count -ge 2
    $TensorParallelCheck.Visibility = if ($showTensorParallel) { 'Visible' } else { 'Collapsed' }
    $TensorParallelHint.Visibility = $TensorParallelCheck.Visibility
    $MtpCheck.Visibility = if ($managedLocal) { 'Visible' } else { 'Collapsed' }
    if (-not $managedLocal) {
        $TensorParallelCheck.IsChecked = $false
        $MtpCheck.IsChecked = $false
        $MtpDepthPanel.Visibility = 'Collapsed'
    }
}

function Resolve-InstallLocation {
    $raw = $InstallLocation.Text.Trim()
    if (-not $raw) { throw 'Choose an installation folder.' }
    try {
        $path = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($raw))
    } catch {
        throw 'The installation folder is not a valid Windows path.'
    }
    if (Test-Path -LiteralPath $path) {
        if (-not (Test-Path -LiteralPath (Join-Path $path '.git'))) {
            $entries = @(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop)
            if ($entries.Count -gt 0) {
                throw 'The selected folder is not empty and is not an existing Jun repository. Choose an empty folder.'
            }
        }
    }
    return $path
}

function Validate-Options {
    $provider = Get-SelectedTag $ProviderCombo
    if ($provider -eq 'openrouter') {
        if ([string]::IsNullOrWhiteSpace($OpenRouterKey.Password)) {
            throw 'Enter an OpenRouter API key, or choose a local provider.'
        }
        if ([string]::IsNullOrWhiteSpace($OpenRouterModel.Text)) {
            throw 'Enter an OpenRouter model ID.'
        }
    }
    if ($provider -eq 'llamacpp' -and $LlamaUrl.Text.Trim() -and
        $LlamaUrl.Text.Trim() -notmatch '^https?://') {
        throw 'The llama-server URL must begin with http:// or https://.'
    }
}

function Validate-Assets {
    if ($ExtractCheck.IsChecked -ne $true) { return }
    if ($AssetAgreement.IsChecked -ne $true) {
        throw 'Confirm the personal-use asset agreement to enable recovery.'
    }
    $gamePath = $GameLocation.Text.Trim()
    if ($gamePath -and -not (Test-Path -LiteralPath $gamePath)) {
        throw 'The selected game folder does not exist.'
    }
}

function Get-SetupValues {
    $express = $ExpressRadio.IsChecked -eq $true
    $provider = if ($express) { 'ollama' } else { Get-SelectedTag $ProviderCombo }
    $model = if ($express) { $script:recommendedModel } else { Get-SelectedTag $ModelCombo }
    return @{
        Express = $express
        Provider = $provider
        Model = $model
        TensorParallel = (-not $express -and $TensorParallelCheck.IsChecked -eq $true)
        Voice = ($express -or $VoiceCheck.IsChecked -eq $true)
        Karaoke = ($express -or $KaraokeCheck.IsChecked -eq $true)
        Mtp = ($express -or $MtpCheck.IsChecked -eq $true)
        MtpDepth = (Get-SelectedTag $MtpDepthCombo)
        Extract = ($ExtractCheck.IsChecked -eq $true)
    }
}

function Update-Review {
    $values = Get-SetupValues
    $path = Resolve-InstallLocation
    $providerNames = @{ ollama = 'Ollama (local)'; openrouter = 'OpenRouter (cloud)'; llamacpp = 'llama.cpp (local)' }
    $modelText = if ($values.Provider -eq 'openrouter') {
        $OpenRouterModel.Text.Trim()
    } elseif ($values.Provider -eq 'llamacpp' -and $LlamaUrl.Text.Trim()) {
        "Existing server at $($LlamaUrl.Text.Trim())"
    } else {
        $values.Model -replace '^hf\.co/efficiencyx/', ''
    }
    $lines = @(
        "Folder       $path",
        "Setup        $(if ($values.Express) { 'Express' } else { 'Custom' })",
        "Provider     $($providerNames[$values.Provider])",
        "Model        $modelText",
        "Voice        $(if ($values.Voice) { 'On' } else { 'Off' })",
        "Karaoke      $(if ($values.Karaoke) { 'On' } else { 'Off' })",
        "Live2D       $(if ($values.Extract) { 'Recover from your game copy' } else { 'Use placeholders for now' })"
    )
    if ($values.TensorParallel) { $lines += 'Multi-GPU    On' }
    if ($values.Mtp) { $lines += "MTP           On (depth: $($values.MtpDepth))" }
    $ReviewText.Text = $lines -join [Environment]::NewLine
}

$pages = @($WelcomePage, $OptionsPage, $AssetsPage, $ReviewPage, $InstallPage)
$pageTitles = @('Choose a location', 'Installation options', 'Personal game assets', 'Review', 'Installation')
$script:pageIndex = 0
$script:installing = $false
$script:process = $null
$script:processOutput = $null
$script:installPath = $null

function Set-Page([int]$index) {
    for ($i = 0; $i -lt $pages.Count; $i++) {
        $pages[$i].Visibility = if ($i -eq $index) { 'Visible' } else { 'Collapsed' }
    }
    $script:pageIndex = $index
    $StepText.Text = if ($index -lt 4) { "Step $($index + 1) of 4" } else { 'Installing' }
    $HeaderSubtitle.Text = $pageTitles[$index]
    $BackButton.IsEnabled = $index -gt 0 -and $index -lt 4
    $BackButton.Visibility = if ($index -lt 4) { 'Visible' } else { 'Collapsed' }
    $NextButton.Visibility = if ($index -lt 4) { 'Visible' } else { 'Collapsed' }
    $NextButton.Content = if ($index -eq 3) { 'Install' } else { 'Next' }
    if ($index -eq 3) {
        $NextButton.IsEnabled = $DependencyAgreement.IsChecked -eq $true
    } else {
        $NextButton.IsEnabled = $true
    }
}

function Browse-ForFolder([string]$description, [string]$initialPath) {
    $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
    $dialog.Description = $description
    $dialog.ShowNewFolderButton = $true
    if ($initialPath -and (Test-Path -LiteralPath $initialPath)) {
        $dialog.SelectedPath = $initialPath
    }
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        return $dialog.SelectedPath
    }
    return $null
}

function Add-InstallerLine([string]$line) {
    if ([string]::IsNullOrWhiteSpace($line)) { return }
    $plain = [regex]::Replace($line, "$([char]27)\[[0-9;]*[A-Za-z]", '')
    $InstallLog.AppendText($plain + [Environment]::NewLine)
    $InstallLog.ScrollToEnd()
    $trimmed = $plain.Trim()
    if ($trimmed -match '^[▸✓⚠✗]\s*(.+)$') {
        $InstallStatus.Text = $matches[1]
    } elseif ($trimmed -match '^(install|download|clone|update|configure|check|set up|starting|tune)\b') {
        $InstallStatus.Text = $trimmed
    }
}

function Get-JunUrl {
    $port = '8080'
    $envPath = Join-Path $script:installPath '.env'
    if (Test-Path -LiteralPath $envPath) {
        $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^JUN_PORT=' } | Select-Object -Last 1
        if ($line) { $port = $line.Substring($line.IndexOf('=') + 1).Trim() }
    }
    return "https://127.0.0.1:$port"
}

function Complete-Installation([int]$exitCode) {
    $script:installing = $false
    if ($script:tempInstaller) {
        Remove-Item -LiteralPath $script:tempInstaller -Force -ErrorAction SilentlyContinue
        $script:tempInstaller = $null
    }
    $InstallProgress.IsIndeterminate = $false
    $InstallProgress.Value = if ($exitCode -eq 0) { 100 } else { 0 }
    $CancelButton.Content = 'Close'
    $CompletionActions.Visibility = 'Visible'
    if ($exitCode -eq 0) {
        $InstallHeading.Text = 'Jun OS is ready'
        $InstallStatus.Text = 'Installation completed successfully.'
        $StepText.Text = 'Complete'
        $OpenSiteButton.IsEnabled = $true
    } else {
        $InstallHeading.Text = 'Installation needs attention'
        $InstallStatus.Text = "The installer exited with code $exitCode. Review the log above, correct the problem, and run this installer again."
        $StepText.Text = 'Not completed'
        $OpenSiteButton.IsEnabled = $false
    }
}

function Drain-InstallerOutput {
    if ($null -eq $script:processOutput) { return }
    $line = [string]::Empty
    while ($script:processOutput.Lines.TryDequeue([ref]$line)) {
        Add-InstallerLine $line
        $line = [string]::Empty
    }
}

$script:pollTimer = [Windows.Threading.DispatcherTimer]::new()
$script:pollTimer.Interval = [TimeSpan]::FromMilliseconds(150)
$script:pollTimer.Add_Tick({
    Drain-InstallerOutput
    if ($null -eq $script:process -or -not $script:process.HasExited) { return }
    $script:process.WaitForExit()
    Drain-InstallerOutput
    $script:pollTimer.Stop()
    if ($script:installing) { Complete-Installation $script:process.ExitCode }
})

function Stop-Installation {
    if ($null -eq $script:process -or $script:process.HasExited) { return }
    try {
        $killer = [Diagnostics.ProcessStartInfo]::new()
        $killer.FileName = 'taskkill.exe'
        $killer.Arguments = "/PID $($script:process.Id) /T /F"
        $killer.CreateNoWindow = $true
        $killer.UseShellExecute = $false
        $taskkill = [Diagnostics.Process]::Start($killer)
        $taskkill.WaitForExit()
    } catch {
        try { $script:process.Kill() } catch {}
    }
}

function Start-Installation {
    $installer = Resolve-InstallerScript

    $values = Get-SetupValues
    $script:installPath = Resolve-InstallLocation
    $installParent = Split-Path -Parent $script:installPath
    if (-not $installParent) { throw 'Choose an installation folder below the drive root.' }
    if (-not (Test-Path -LiteralPath $installParent)) {
        New-Item -ItemType Directory -Path $installParent -Force | Out-Null
    }
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $script:PowerShellExe
    $info.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$installer`""
    # NOT $PSScriptRoot: a compiled build can sit on a read only stick or in
    # Downloads, and install.ps1 writes next to its working dir. the parent of
    # the chosen folder is the one place we already know is writable.
    $info.WorkingDirectory = $installParent
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8

    $managedKeys = @(
        'JUN_YES', 'JUN_EXPRESS', 'JUN_DIR', 'JUN_PROVIDER', 'JUN_MODEL',
        'JUN_TENSOR_PARALLEL', 'JUN_MTP', 'JUN_MTP_DEPTH', 'JUN_KARAOKE',
        'JUN_EXTRACT', 'JUN_GAME_DIR', 'JUN_BOOTSTRAP_WINGET', 'VOICE',
        'KARAOKE', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'LLAMACPP_URL'
    )
    foreach ($key in $managedKeys) { $info.EnvironmentVariables.Remove($key) }

    $info.EnvironmentVariables['JUN_YES'] = '1'
    $info.EnvironmentVariables['JUN_DIR'] = $script:installPath
    $info.EnvironmentVariables['JUN_PROVIDER'] = $values.Provider
    $info.EnvironmentVariables['JUN_MODEL'] = $values.Model
    $info.EnvironmentVariables['JUN_TENSOR_PARALLEL'] = if ($values.TensorParallel) { 'on' } else { 'off' }
    $info.EnvironmentVariables['VOICE'] = if ($values.Voice) { 'on' } else { 'off' }
    $info.EnvironmentVariables['JUN_KARAOKE'] = if ($values.Karaoke) { 'on' } else { 'off' }
    $info.EnvironmentVariables['JUN_MTP'] = if ($values.Mtp) { 'on' } else { 'off' }
    $info.EnvironmentVariables['JUN_MTP_DEPTH'] = $values.MtpDepth
    $info.EnvironmentVariables['JUN_EXTRACT'] = if ($values.Extract) { 'on' } else { 'off' }
    $info.EnvironmentVariables['JUN_BOOTSTRAP_WINGET'] = '1'

    if ($values.Extract -and $GameLocation.Text.Trim()) {
        $info.EnvironmentVariables['JUN_GAME_DIR'] = $GameLocation.Text.Trim()
    }
    if ($values.Provider -eq 'openrouter') {
        $info.EnvironmentVariables['OPENROUTER_API_KEY'] = $OpenRouterKey.Password
        $info.EnvironmentVariables['OPENROUTER_MODEL'] = $OpenRouterModel.Text.Trim()
    }
    if ($values.Provider -eq 'llamacpp' -and $LlamaUrl.Text.Trim()) {
        $info.EnvironmentVariables['LLAMACPP_URL'] = $LlamaUrl.Text.Trim()
    }

    $script:process = [Diagnostics.Process]::new()
    $script:process.StartInfo = $info
    $script:processOutput = [InstallerProcessOutput]::new()
    $script:processOutput.Attach($script:process)

    if (-not $script:process.Start()) { throw 'Windows could not start the installer process.' }
    $script:installing = $true
    Set-Page 4
    Add-InstallerLine "Installing to $($script:installPath)"
    $script:process.BeginOutputReadLine()
    $script:process.BeginErrorReadLine()
    $script:pollTimer.Start()
}

$BrowseInstallButton.Add_Click({
    $selected = Browse-ForFolder 'Choose the Jun OS installation folder' $InstallLocation.Text.Trim()
    if ($selected) { $InstallLocation.Text = $selected }
})

$BrowseGameButton.Add_Click({
    $selected = Browse-ForFolder 'Choose the My Dystopian Robot Girlfriend folder' $GameLocation.Text.Trim()
    if ($selected) { $GameLocation.Text = $selected }
})

$ExpressRadio.Add_Checked({ Update-Mode })
$CustomRadio.Add_Checked({ Update-Mode })
$ProviderCombo.Add_SelectionChanged({ Update-ProviderPanels })
$LlamaUrl.Add_TextChanged({ Update-ProviderPanels })
$TensorParallelCheck.Add_Click({ Select-Model (Get-RecommendedModel ($TensorParallelCheck.IsChecked -eq $true)) })
$VoiceCheck.Add_Click({
    $voiceEnabled = $VoiceCheck.IsChecked -eq $true
    $KaraokeCheck.Visibility = if ($voiceEnabled) { 'Visible' } else { 'Collapsed' }
    if (-not $voiceEnabled) { $KaraokeCheck.IsChecked = $false }
})
$MtpCheck.Add_Click({
    $MtpDepthPanel.Visibility = if ($MtpCheck.IsChecked -eq $true) { 'Visible' } else { 'Collapsed' }
})
$ExtractCheck.Add_Click({
    $AssetOptions.Visibility = if ($ExtractCheck.IsChecked -eq $true) { 'Visible' } else { 'Collapsed' }
})
$DependencyAgreement.Add_Click({
    if ($script:pageIndex -eq 3) { $NextButton.IsEnabled = $DependencyAgreement.IsChecked -eq $true }
})

$BackButton.Add_Click({
    if ($script:pageIndex -gt 0 -and $script:pageIndex -lt 4) {
        Set-Page ($script:pageIndex - 1)
    }
})

$NextButton.Add_Click({
    try {
        switch ($script:pageIndex) {
            0 {
                $null = Resolve-InstallLocation
                Set-Page 1
            }
            1 {
                Validate-Options
                Set-Page 2
            }
            2 {
                Validate-Assets
                Update-Review
                Set-Page 3
            }
            3 {
                if ($DependencyAgreement.IsChecked -ne $true) {
                    throw 'Confirm installation of missing prerequisites before continuing.'
                }
                Start-Installation
            }
        }
    } catch {
        Show-Message $_.Exception.Message
    }
})

$CancelButton.Add_Click({
    if ($script:installing) {
        $answer = [System.Windows.MessageBox]::Show(
            $window,
            'Installation is still running. Stop it now?',
            'Cancel installation',
            [System.Windows.MessageBoxButton]::YesNo,
            [System.Windows.MessageBoxImage]::Warning
        )
        if ($answer -ne [System.Windows.MessageBoxResult]::Yes) { return }
        Stop-Installation
        $script:installing = $false
    }
    $window.Close()
})

$OpenFolderButton.Add_Click({
    if ($script:installPath -and (Test-Path -LiteralPath $script:installPath)) {
        Start-Process explorer.exe -ArgumentList ('"' + $script:installPath + '"')
    }
})
$OpenSiteButton.Add_Click({ Start-Process (Get-JunUrl) })

$window.Add_Closing({
    param($sender, $eventArgs)
    if (-not $script:installing) { return }
    $answer = [System.Windows.MessageBox]::Show(
        $window,
        'Installation is still running. Stop it and close setup?',
        'Close Jun OS Setup',
        [System.Windows.MessageBoxButton]::YesNo,
        [System.Windows.MessageBoxImage]::Warning
    )
    if ($answer -eq [System.Windows.MessageBoxResult]::Yes) {
        Stop-Installation
        $script:installing = $false
    } else {
        $eventArgs.Cancel = $true
    }
})

Update-Mode
Update-ProviderPanels
Set-Page 0
$null = $window.ShowDialog()
