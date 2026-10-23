//go:build !windows

package main

import (
	"fmt"
	"os/exec"
	"runtime"
)

func openWindow(url string) {
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	if err := exec.Command(name, url).Start(); err != nil {
		fmt.Println("Abre esta dirección en tu navegador:", url)
	}
}
