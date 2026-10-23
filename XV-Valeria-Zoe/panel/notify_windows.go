//go:build windows

package main

import (
	"encoding/base64"
	"log"
	"os"
	"os/exec"
	"syscall"
	"unicode/utf16"
)

// Notificación nativa de Windows 10/11 (toast) usando PowerShell, sin dependencias.
const toastScript = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$t = [System.Security.SecurityElement]::Escape($env:XV_TITLE)
$m = [System.Security.SecurityElement]::Escape($env:XV_TEXT)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>Mis XV · Valeria Zoe</text><text>$t</text><text>$m</text></binding></visual><audio src='ms-winsoundevent:Notification.Default'/></toast>")
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)
`

func encodePS(s string) string {
	u := utf16.Encode([]rune(s))
	b := make([]byte, 0, len(u)*2)
	for _, c := range u {
		b = append(b, byte(c), byte(c>>8))
	}
	return base64.StdEncoding.EncodeToString(b)
}

func nativeToast(title, text string) {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
		"-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePS(toastScript))
	cmd.Env = append(os.Environ(), "XV_TITLE="+title, "XV_TEXT="+text)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	if err := cmd.Start(); err != nil {
		log.Printf("notificación: %v", err)
		return
	}
	go func() {
		if err := cmd.Wait(); err != nil {
			log.Printf("notificación (powershell): %v", err)
		}
	}()
}
