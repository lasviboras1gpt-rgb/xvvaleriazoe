// Panel de control de invitaciones XV — Valeria Zoe.
// Un solo ejecutable: abre su propia ventana, muestra estadísticas, administra invitados
// y avisa con notificaciones de Windows cuando alguien abre, confirma o modifica.
package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"time"
)

func main() {
	dir := dataDir()
	_ = os.MkdirAll(dir, 0o700)
	if f, err := os.OpenFile(filepath.Join(dir, "panel.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		defer f.Close()
		log.SetOutput(f)
	}
	log.SetFlags(log.LstdFlags)

	// ¿Ya hay un panel abierto? Solo se vuelve a mostrar su ventana.
	if s, ok := liveSession(dir); ok {
		openWindow(s.URL())
		return
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("no se pudo iniciar el servidor local: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	token := newToken()

	app := newApp(loadConfig(dir))
	srv := &http.Server{Handler: app.handler(port, token), ReadHeaderTimeout: 10 * time.Second}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	sess := Session{Port: port, Token: token}
	if err := saveSession(dir, sess); err != nil {
		log.Printf("no se pudo guardar la sesión: %v", err)
	}
	defer clearSession(dir)

	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("servidor: %v", err)
			stop()
		}
	}()
	go app.pollLoop(ctx)
	go app.watchdog(ctx, stop)

	log.Printf("panel listo en puerto %d", port)
	if os.Getenv("XV_NO_WINDOW") == "" {
		openWindow(sess.URL())
	} else {
		fmt.Println(sess.URL())
	}

	<-ctx.Done()
	shut, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = srv.Shutdown(shut)
}
