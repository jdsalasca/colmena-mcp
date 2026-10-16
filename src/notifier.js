import { spawn } from 'node:child_process';

// Toast through Windows PowerShell 5.1 (WinRT). Title/body travel in env vars, never interpolated into the script.
const TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$t = [System.Security.SecurityElement]::Escape($env:COLMENA_T)
$b = [System.Security.SecurityElement]::Escape($env:COLMENA_B)
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">' + $t + '</text><text id="2">' + $b + '</text></binding></visual></toast>')
$n = [Windows.UI.Notifications.ToastNotification]::new($x)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($n)
`;

export function createNotifier(kind = 'toast') {
  if (kind !== 'toast' || process.platform !== 'win32') return { send() {} };
  return {
    send({ title, body }) {
      try {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TOAST_SCRIPT], {
          windowsHide: true, stdio: 'ignore', env: { ...process.env, COLMENA_T: String(title).slice(0, 120), COLMENA_B: String(body).slice(0, 300) },
        });
        child.on('error', () => {});
        child.unref();
      } catch { /* notifications are best-effort */ }
    },
  };
}
