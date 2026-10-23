//go:build windows

package main

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// openWindow abre el panel en una ventana propia (modo aplicación de Edge o Chrome,
// que vienen con Windows 10/11). Si no hay ninguno, usa el navegador predeterminado.
func openWindow(url string) {
	var candidates []string
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LocalAppData"} {
		base := os.Getenv(env)
		if base == "" {
			continue
		}
		candidates = append(candidates,
			filepath.Join(base, `Microsoft\Edge\Application\msedge.exe`),
			filepath.Join(base, `Google\Chrome\Application\chrome.exe`),
		)
	}
	for _, exe := range candidates {
		if _, err := os.Stat(exe); err != nil {
			continue
		}
		cmd := exec.Command(exe, "--app="+url, "--window-size=1320,880")
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: false}
		if err := cmd.Start(); err == nil {
			go cmd.Wait()
			return
		}
	}
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := cmd.Start(); err != nil {
		log.Printf("no se pudo abrir el navegador: %v", err)
	}
}
