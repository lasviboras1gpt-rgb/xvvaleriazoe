package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDescribe(t *testing.T) {
	cases := []struct {
		e    Event
		want string
	}{
		{Event{Type: "open", Guest: "Ana", FirstOpen: true}, "Ana abrió su invitación por primera vez"},
		{Event{Type: "open", Guest: "Ana"}, "Ana volvió a abrir su invitación"},
		{Event{Type: "confirm", Guest: "Ana", Count: 1, Seats: 4}, "Ana confirmó 1 lugar de 4 asignados"},
		{Event{Type: "confirm", Guest: "Ana", Count: 3, Seats: 4}, "Ana confirmó 3 lugares de 4 asignados"},
		{Event{Type: "decline", Guest: "Ana"}, "Ana avisó que no podrá asistir"},
		{Event{Type: "modify", Guest: "Ana", Status: "confirmed", PreviousStatus: "confirmed", PreviousCount: 4, Count: 2}, "Ana cambió de 4 lugares a 2 lugares"},
		{Event{Type: "modify", Guest: "Ana", Status: "declined", PreviousStatus: "confirmed"}, "Ana cambió su respuesta: ya no podrá asistir"},
		{Event{Type: "modify", Guest: "Ana", Status: "confirmed", PreviousStatus: "declined", Count: 2}, "Ana cambió su respuesta: ahora asistirá con 2 lugares"},
	}
	for _, c := range cases {
		e := c.e
		describe(&e)
		if e.Text != c.want {
			t.Errorf("got %q want %q", e.Text, c.want)
		}
		if e.Title == "" {
			t.Errorf("sin título: %+v", c.e)
		}
	}
}

func TestNormalizeSite(t *testing.T) {
	cases := map[string]string{
		"mi-sitio.netlify.app":          "https://mi-sitio.netlify.app",
		"https://mi-sitio.netlify.app/": "https://mi-sitio.netlify.app",
		"  localhost:8888 ":             "http://localhost:8888",
		"http://127.0.0.1:8888/":        "http://127.0.0.1:8888",
	}
	for in, want := range cases {
		got, ok := normalizeSite(in)
		if !ok || got != want {
			t.Errorf("%q -> %q (%v), want %q", in, got, ok, want)
		}
	}
	for _, bad := range []string{"", "   ", "ftp://x.com", "https://"} {
		if _, ok := normalizeSite(bad); ok {
			t.Errorf("%q debería ser inválido", bad)
		}
	}
}

// Servidor remoto de mentira que simula la API de eventos.
type fakeRemote struct {
	mu     sync.Mutex
	events []Event
	pw     string
}

func (f *fakeRemote) add(e Event) {
	f.mu.Lock()
	defer f.mu.Unlock()
	e.Key = strings.Repeat("0", 5) + string(rune('a'+len(f.events)))
	f.events = append(f.events, e)
}

func (f *fakeRemote) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+f.pw {
		w.WriteHeader(401)
		return
	}
	switch r.URL.Path {
	case "/api/admin/ping":
		w.Write([]byte(`{"ok":true}`))
	case "/api/admin/events":
		after := r.URL.Query().Get("after")
		f.mu.Lock()
		out := []Event{}
		for _, e := range f.events {
			if after == "" || e.Key > after {
				out = append(out, e)
			}
		}
		f.mu.Unlock()
		cur := after
		if len(out) > 0 {
			cur = out[len(out)-1].Key
		}
		json.NewEncoder(w).Encode(map[string]any{"events": out, "cursor": cur})
	default:
		w.WriteHeader(404)
	}
}

type sink struct {
	mu   sync.Mutex
	list []string
}

func (s *sink) add(title, text string) {
	s.mu.Lock()
	s.list = append(s.list, title+"|"+text)
	s.mu.Unlock()
}
func (s *sink) all() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.list...)
}

func newTestApp(t *testing.T, remote *httptest.Server, dir string) (*App, *sink) {
	t.Helper()
	cs := loadConfig(dir)
	_ = cs.Update(func(c *Config) { c.Site = remote.URL })
	a := newApp(cs)
	a.token = "secreta"
	s := &sink{}
	a.notify = s.add
	return a, s
}

func TestPollNotificaSoloLoNuevo(t *testing.T) {
	fr := &fakeRemote{pw: "secreta"}
	fr.add(Event{Type: "open", Guest: "Viejo", FirstOpen: true})
	fr.add(Event{Type: "confirm", Guest: "Viejo", Count: 2, Seats: 2})
	remote := httptest.NewServer(fr)
	defer remote.Close()
	dir := t.TempDir()
	a, s := newTestApp(t, remote, dir)
	ctx := context.Background()

	// 1) Primera vez que se usa: carga el historial pero NO notifica.
	a.pollOnce(ctx)
	if n := len(s.all()); n != 0 {
		t.Fatalf("no debía notificar el historial: %v", s.all())
	}
	if got := len(a.feedAfter("")); got != 2 {
		t.Fatalf("historial = %d", got)
	}
	if a.Status() != "ok" {
		t.Fatalf("status %s", a.Status())
	}

	// 2) Llega una apertura: notifica una vez, y consultar otra vez no repite.
	fr.add(Event{Type: "open", Guest: "Marta", FirstOpen: true})
	a.pollOnce(ctx)
	a.pollOnce(ctx)
	got := s.all()
	if len(got) != 1 || !strings.Contains(got[0], "Marta abrió su invitación por primera vez") {
		t.Fatalf("notificaciones: %v", got)
	}

	// 3) Muchas novedades juntas: máx. 4 individuales + 1 resumen.
	for i := 0; i < 7; i++ {
		fr.add(Event{Type: "open", Guest: "G"})
	}
	a.pollOnce(ctx)
	if n := len(s.all()); n != 1+4+1 {
		t.Fatalf("esperaba 6 avisos en total, hubo %d: %v", n, s.all())
	}

	// 4) Reinicio del programa: lo ocurrido mientras estuvo cerrado llega como resumen.
	fr.add(Event{Type: "confirm", Guest: "Luis", Count: 1, Seats: 3})
	fr.add(Event{Type: "modify", Guest: "Luis", Status: "confirmed", PreviousStatus: "confirmed", PreviousCount: 1, Count: 2, Seats: 3})
	a2, s2 := newTestApp(t, remote, dir) // mismo config.json => recuerda lastSeen
	a2.pollOnce(ctx)
	g2 := s2.all()
	if len(g2) != 1 || !strings.Contains(g2[0], "2 novedades") {
		t.Fatalf("resumen al reiniciar: %v", g2)
	}
}

func TestPollContrasenaIncorrecta(t *testing.T) {
	fr := &fakeRemote{pw: "otra"}
	remote := httptest.NewServer(fr)
	defer remote.Close()
	a, _ := newTestApp(t, remote, t.TempDir())
	a.pollOnce(context.Background())
	if a.Status() != "unauthorized" {
		t.Fatalf("status = %s", a.Status())
	}
}

func TestPollSinConexion(t *testing.T) {
	remote := httptest.NewServer(&fakeRemote{pw: "secreta"})
	a, _ := newTestApp(t, remote, t.TempDir())
	remote.Close()
	a.pollOnce(context.Background())
	if a.Status() != "offline" {
		t.Fatalf("status = %s", a.Status())
	}
}

func TestSeguridadServidorLocal(t *testing.T) {
	remote := httptest.NewServer(&fakeRemote{pw: "secreta"})
	defer remote.Close()
	a, _ := newTestApp(t, remote, t.TempDir())
	ts := httptest.NewUnstartedServer(nil)
	ts.Start()
	defer ts.Close()
	var p int
	for _, c := range ts.Listener.Addr().String()[strings.LastIndex(ts.Listener.Addr().String(), ":")+1:] {
		p = p*10 + int(c-'0')
	}
	ts.Config.Handler = a.handler(p, "TOKEN123")

	do := func(method, path, host string, hdr map[string]string) int {
		req, _ := http.NewRequest(method, ts.URL+path, nil)
		if host != "" {
			req.Host = host
		}
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		cli := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Timeout: 5 * time.Second}
		resp, err := cli.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	cookie := map[string]string{"Cookie": "xvt=TOKEN123"}

	if c := do("GET", "/local/config", "", nil); c != 403 {
		t.Errorf("sin cookie debe ser 403, fue %d", c)
	}
	if c := do("GET", "/local/config", "", map[string]string{"Cookie": "xvt=mala"}); c != 403 {
		t.Errorf("cookie mala debe ser 403, fue %d", c)
	}
	if c := do("GET", "/local/config", "evil.example.com", cookie); c != 403 {
		t.Errorf("Host ajeno (DNS rebinding) debe ser 403, fue %d", c)
	}
	if c := do("GET", "/?t=mal", "", nil); c != 403 {
		t.Errorf("token malo debe ser 403, fue %d", c)
	}
	if c := do("GET", "/?t=TOKEN123", "", nil); c != 302 {
		t.Errorf("token bueno debe redirigir, fue %d", c)
	}
	if c := do("GET", "/local/config", "", cookie); c != 200 {
		t.Errorf("con cookie debe ser 200, fue %d", c)
	}
	if c := do("GET", "/api/admin/ping", "", cookie); c != 200 {
		t.Errorf("proxy con cookie debe ser 200, fue %d", c)
	}
	h := map[string]string{"Cookie": "xvt=TOKEN123", "Origin": "https://evil.example.com"}
	if c := do("POST", "/local/config", "", h); c != 403 {
		t.Errorf("POST con Origin ajeno debe ser 403, fue %d", c)
	}
}

func TestGuardarConfiguracionSinContrasena(t *testing.T) {
	remote := httptest.NewServer(&fakeRemote{pw: "secreta"})
	defer remote.Close()
	cs := loadConfig(t.TempDir())
	a := newApp(cs)
	a.token = "secreta" // clave incrustada del programa
	ts := httptest.NewUnstartedServer(nil)
	ts.Start()
	defer ts.Close()
	port := 0
	for _, c := range ts.Listener.Addr().String()[strings.LastIndex(ts.Listener.Addr().String(), ":")+1:] {
		port = port*10 + int(c-'0')
	}
	ts.Config.Handler = a.handler(port, "T")
	post := func(body string) (int, string) {
		req, _ := http.NewRequest("POST", ts.URL+"/local/config", strings.NewReader(body))
		req.Header.Set("Cookie", "xvt=T")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var m map[string]any
		json.NewDecoder(resp.Body).Decode(&m)
		b, _ := json.Marshal(m)
		return resp.StatusCode, string(b)
	}
	if c, _ := post(`{"site":""}`); c != 400 {
		t.Errorf("sitio vacío: %d", c)
	}
	// El sitio existe pero no reconoce la clave incrustada
	a.token = "otra-clave"
	if c, b := post(`{"site":"` + remote.URL + `"}`); c != 401 || !strings.Contains(b, "rejected") {
		t.Errorf("clave rechazada: %d %s", c, b)
	}
	// Dirección que no es la invitación (404) y sitio apagado
	notOurs := httptest.NewServer(http.NotFoundHandler())
	defer notOurs.Close()
	a.token = "secreta"
	if c, b := post(`{"site":"` + notOurs.URL + `"}`); c != 404 || !strings.Contains(b, "not_our_site") {
		t.Errorf("no es nuestro sitio: %d %s", c, b)
	}
	notReady := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer notReady.Close()
	if c, b := post(`{"site":"` + notReady.URL + `"}`); c != 503 || !strings.Contains(b, "server_not_ready") {
		t.Errorf("servidor sin clave configurada: %d %s", c, b)
	}
	if c, b := post(`{"site":"localhost:9"}`); c != 502 || !strings.Contains(b, "unreachable") {
		t.Errorf("inalcanzable: %d %s", c, b)
	}
	// Correcto: no se pide contraseña
	if c, b := post(`{"site":"` + remote.URL + `"}`); c != 200 {
		t.Errorf("config válida: %d %s", c, b)
	}
	if got := cs.Get(); got.Site != remote.URL {
		t.Errorf("no guardó el sitio: %+v", got)
	}
	// Programa compilado sin clave (versión de pruebas): lo dice claro
	a.token = ""
	if c, b := post(`{"site":"` + remote.URL + `"}`); c != 409 || !strings.Contains(b, "no_token") {
		t.Errorf("sin clave incrustada: %d %s", c, b)
	}
}

func TestConfigAntiguaConContrasenaSeIgnora(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"site":"https://x.netlify.app","password":"vieja","lastSeen":"k1"}`), 0o600)
	cs := loadConfig(dir)
	if got := cs.Get(); got.Site != "https://x.netlify.app" || got.LastSeen != "k1" {
		t.Fatalf("%+v", got)
	}
	_ = cs.Update(func(c *Config) { c.LastSeen = "k2" })
	b, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	if strings.Contains(string(b), "vieja") || strings.Contains(string(b), "password") {
		t.Fatalf("la contraseña antigua no debe volver a guardarse: %s", b)
	}
}
