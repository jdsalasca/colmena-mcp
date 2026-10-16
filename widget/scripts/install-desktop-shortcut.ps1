[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string] $ExecutablePath = (Join-Path $PSScriptRoot '..\dist\colmena-widget.exe'),
    [string] $ShortcutName = 'Colmena Widget',
    [string] $DesktopPath = [Environment]::GetFolderPath('Desktop'),
    [switch] $IncludeStartMenu,
    [string] $StartMenuPath = [Environment]::GetFolderPath('Programs')
)

$resolvedExecutable = [IO.Path]::GetFullPath($ExecutablePath)
if (-not (Test-Path -LiteralPath $resolvedExecutable -PathType Leaf)) {
    throw "No existe el ejecutable: $resolvedExecutable"
}

$destinations = @((Join-Path $DesktopPath "$ShortcutName.lnk"))
if ($IncludeStartMenu) {
    $destinations += Join-Path $StartMenuPath "$ShortcutName.lnk"
}

foreach ($shortcutPath in $destinations) {
    if ($PSCmdlet.ShouldProcess($shortcutPath, 'Crear acceso directo de Colmena Widget')) {
        $directory = Split-Path -Parent $shortcutPath
        New-Item -ItemType Directory -Path $directory -Force | Out-Null

        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $resolvedExecutable
        $shortcut.WorkingDirectory = Split-Path -Parent $resolvedExecutable
        $shortcut.Description = 'Mostrar jobs locales de Colmena en el escritorio'
        $shortcut.Save()
    }
}
