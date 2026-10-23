//go:build !windows

package main

import "log"

// En sistemas que no son Windows (pruebas) solo se registra el aviso.
func nativeToast(title, text string) { log.Printf("NOTIFICACIÓN: %s — %s", title, text) }
