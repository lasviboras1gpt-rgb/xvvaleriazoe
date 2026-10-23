package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// adminToken es la clave de administración incrustada al compilar:
//
//	go build -ldflags "-X main.adminToken=<clave>"
//
// El servidor solo acepta crear/editar/eliminar invitaciones de un programa que la lleve.
var adminToken = ""

type App struct {
	cfg    *ConfigStore
	client *http.Client
	token  string

	mu     sync.Mutex
	feed   []Event // más antiguo → más reciente
	cursor string
	status string // ok | unconfigured | unauthorized | offline
	inited bool   // ya se hizo la primera consulta de esta sesión

	notify func(title, text string)

	lastUI    atomic.Int64 // última vez que el panel (ventana) habló con nosotros
	closingAt atomic.Int64 // la ventana avisó que se está cerrando
	pollEvery time.Duration
}

func newApp(cfg *ConfigStore) *App {
	a := &App{
		cfg:       cfg,
		token:     firstNonEmpty(adminToken, os.Getenv("XV_ADMIN_TOKEN")),
		client:    &http.Client{Timeout: 15 * time.Second},
		status:    "unconfigured",
		notify:    nativeToast,
		pollEvery: 4 * time.Second,
	}
	a.cursor = cfg.Get().LastSeen
	a.lastUI.Store(time.Now().UnixMilli())
	return a
}

func (a *App) setStatus(s string) {
	a.mu.Lock()
	a.status = s
	a.mu.Unlock()
}

func (a *App) Status() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.status
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// siteURL devuelve la dirección del sitio y la clave incrustada.
func (a *App) siteURL() (*url.URL, string, bool) {
	site, ok := normalizeSite(a.cfg.Get().Site)
	if !ok || a.token == "" {
		return nil, "", false
	}
	u, err := url.Parse(site)
	if err != nil {
		return nil, "", false
	}
	return u, a.token, true
}

var errUnauthorized = errors.New("unauthorized")

// httpError conserva el código HTTP para dar mensajes claros al configurar.
type httpError struct{ Status int }

func (e httpError) Error() string { return fmt.Sprintf("HTTP %d", e.Status) }

// remoteJSON hace una petición autenticada a la API del sitio y decodifica la respuesta.
func (a *App) remoteJSON(ctx context.Context, site, password, method, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, site+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+password)
	resp, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return errUnauthorized
	}
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return httpError{resp.StatusCode}
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out)
}

// verify comprueba sitio + contraseña (usado al guardar la configuración).
func (a *App) verify(ctx context.Context, site, password string) error {
	return a.remoteJSON(ctx, site, password, http.MethodGet, "/api/admin/ping", nil)
}

// resetFeed se usa cuando se cambia de sitio: empieza de cero.
func (a *App) resetFeed() {
	a.mu.Lock()
	a.feed = nil
	a.cursor = ""
	a.inited = false
	a.mu.Unlock()
	_ = a.cfg.Update(func(c *Config) { c.LastSeen = "" })
}

type eventsResp struct {
	Events []Event `json:"events"`
	Cursor string  `json:"cursor"`
}

// pollOnce consulta novedades y dispara notificaciones nativas.
func (a *App) pollOnce(ctx context.Context) {
	u, pw, ok := a.siteURL()
	if !ok {
		if a.token == "" && a.cfg.Get().Site != "" {
			a.setStatus("no_token")
		} else {
			a.setStatus("unconfigured")
		}
		return
	}
	site := u.String()

	a.mu.Lock()
	cursor, inited := a.cursor, a.inited
	a.mu.Unlock()

	var fresh []Event
	for page := 0; page < 20; page++ {
		path := "/api/admin/events?limit=200"
		if cursor != "" {
			path += "&after=" + url.QueryEscape(cursor)
		}
		var r eventsResp
		if err := a.remoteJSON(ctx, site, pw, http.MethodGet, path, &r); err != nil {
			if errors.Is(err, errUnauthorized) {
				a.setStatus("unauthorized")
			} else {
				a.setStatus("offline")
				log.Printf("consulta de eventos falló: %v", err)
			}
			return
		}
		for i := range r.Events {
			describe(&r.Events[i])
		}
		fresh = append(fresh, r.Events...)
		if r.Cursor != "" {
			cursor = r.Cursor
		}
		if len(r.Events) < 200 {
			break
		}
	}

	// ¿Hay que avisar? Solo de lo ocurrido después de la última vez que vimos algo.
	// Primera vez que se usa (sin cursor): se carga el historial sin notificar.
	hadCursor := a.cfg.Get().LastSeen != "" || inited
	a.mu.Lock()
	a.status = "ok"
	a.feed = append(a.feed, fresh...)
	if len(a.feed) > 500 {
		a.feed = a.feed[len(a.feed)-500:]
	}
	a.cursor = cursor
	a.inited = true
	a.mu.Unlock()

	if cursor != "" {
		_ = a.cfg.Update(func(c *Config) { c.LastSeen = cursor })
	}
	if hadCursor && len(fresh) > 0 {
		a.announce(fresh, !inited)
	}
}

// announce envía hasta 4 avisos individuales; si hay más, un resumen.
func (a *App) announce(evs []Event, catchUp bool) {
	if catchUp && len(evs) > 1 {
		a.notify("Novedades desde tu última visita", fmt.Sprintf("Hay %d novedades en las invitaciones. Ábrelas en el panel.", len(evs)))
		return
	}
	const maxIndividual = 4
	for i, e := range evs {
		if i >= maxIndividual {
			a.notify("Más novedades", fmt.Sprintf("Y %d novedades más. Revisa el panel.", len(evs)-maxIndividual))
			return
		}
		a.notify(e.Title, e.Text)
	}
}

func (a *App) pollLoop(ctx context.Context) {
	delay := time.Duration(0)
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		a.pollOnce(ctx)
		delay = a.pollEvery
		if s := a.Status(); s == "offline" || s == "unauthorized" {
			delay = 3 * a.pollEvery
		}
	}
}

func (a *App) feedAfter(key string) []Event {
	a.mu.Lock()
	defer a.mu.Unlock()
	if key == "" {
		out := make([]Event, len(a.feed))
		copy(out, a.feed)
		return out
	}
	var out []Event
	for _, e := range a.feed {
		if e.Key > key {
			out = append(out, e)
		}
	}
	return out
}

func (a *App) lastKey() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if n := len(a.feed); n > 0 {
		return a.feed[n-1].Key
	}
	return ""
}

// watchdog cierra el programa cuando se cierra la ventana del panel.
func (a *App) watchdog(ctx context.Context, quit func()) {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			now := time.Now().UnixMilli()
			last, closing := a.lastUI.Load(), a.closingAt.Load()
			if closing != 0 && last <= closing && now-closing > 10_000 {
				log.Println("ventana cerrada: saliendo")
				quit()
				return
			}
			if now-last > 5*60_000 {
				log.Println("sin actividad de la ventana: saliendo")
				quit()
				return
			}
		}
	}
}

func hostOK(h string, port int) bool {
	return h == fmt.Sprintf("127.0.0.1:%d", port) || h == fmt.Sprintf("localhost:%d", port)
}

func trimSlash(s string) string { return strings.TrimRight(s, "/") }
