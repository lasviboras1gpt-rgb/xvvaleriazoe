package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httputil"
	"strings"
	"time"
)

//go:embed web
var webFS embed.FS

func newToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// handler arma el servidor local. Protecciones:
//   - solo acepta Host 127.0.0.1/localhost (evita DNS rebinding)
//   - exige una cookie secreta de esta sesión (evita que otras páginas web manden órdenes)
func (a *App) handler(port int, token string) http.Handler {
	mux := http.NewServeMux()

	// Proxy a la API de administración del sitio, agregando la contraseña del lado del programa.
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			if u, pw, ok := a.siteURL(); ok {
				r.SetURL(u)
				r.Out.Host = u.Host
				r.Out.Header.Set("Authorization", "Bearer "+pw)
			}
			r.Out.Header.Del("Cookie")
			r.Out.Header.Del("Origin")
			r.Out.Header.Del("Referer")
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "unreachable"})
		},
		Transport: a.client.Transport,
	}
	mux.HandleFunc("/api/admin/", func(w http.ResponseWriter, r *http.Request) {
		if _, _, ok := a.siteURL(); !ok {
			writeJSON(w, http.StatusPreconditionFailed, map[string]string{"error": "not_configured"})
			return
		}
		a.lastUI.Store(time.Now().UnixMilli())
		proxy.ServeHTTP(w, r)
	})

	mux.HandleFunc("/local/config", func(w http.ResponseWriter, r *http.Request) {
		a.lastUI.Store(time.Now().UnixMilli())
		switch r.Method {
		case http.MethodGet:
			site, _ := normalizeSite(a.cfg.Get().Site)
			writeJSON(w, 200, map[string]any{"configured": site != "", "site": site, "status": a.Status(), "hasToken": a.token != ""})
		case http.MethodPost:
			var in struct{ Site string }
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in); err != nil {
				writeJSON(w, 400, map[string]string{"error": "invalid_json"})
				return
			}
			site, ok := normalizeSite(in.Site)
			if !ok {
				writeJSON(w, 400, map[string]string{"error": "invalid_site"})
				return
			}
			if a.token == "" {
				writeJSON(w, 409, map[string]string{"error": "no_token"})
				return
			}
			oldSite, _ := normalizeSite(a.cfg.Get().Site)
			ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
			defer cancel()
			if err := a.verify(ctx, site, a.token); err != nil {
				var he httpError
				switch {
				case errors.Is(err, errUnauthorized):
					writeJSON(w, 401, map[string]string{"error": "rejected"})
				case errors.As(err, &he) && he.Status == 503:
					writeJSON(w, 503, map[string]string{"error": "server_not_ready"})
				case errors.As(err, &he) && he.Status == 404:
					writeJSON(w, 404, map[string]string{"error": "not_our_site"})
				default:
					writeJSON(w, 502, map[string]string{"error": "unreachable"})
				}
				return
			}
			if oldSite != site {
				a.resetFeed()
			}
			_ = a.cfg.Update(func(c *Config) { c.Site = site })
			a.setStatus("ok")
			writeJSON(w, 200, map[string]any{"configured": true, "site": site, "status": "ok"})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/local/feed", func(w http.ResponseWriter, r *http.Request) {
		a.lastUI.Store(time.Now().UnixMilli())
		after := r.URL.Query().Get("after")
		evs := a.feedAfter(after)
		if evs == nil {
			evs = []Event{}
		}
		cur := after
		if k := a.lastKey(); k != "" {
			cur = k
		}
		writeJSON(w, 200, map[string]any{"status": a.Status(), "events": evs, "cursor": cur})
	})

	mux.HandleFunc("/local/closing", func(w http.ResponseWriter, r *http.Request) {
		a.closingAt.Store(time.Now().UnixMilli())
		w.WriteHeader(http.StatusNoContent)
	})

	sub, _ := fs.Sub(webFS, "web")
	static := http.FileServer(http.FS(sub))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		static.ServeHTTP(w, r)
	}))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hostOK(r.Host, port) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		// Primer acceso: /?t=TOKEN guarda la cookie y limpia la URL.
		if r.URL.Path == "/" && r.URL.Query().Get("t") != "" {
			if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("t")), []byte(token)) == 1 {
				http.SetCookie(w, &http.Cookie{Name: "xvt", Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
				http.Redirect(w, r, "/", http.StatusFound)
				return
			}
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		c, err := r.Cookie("xvt")
		if err != nil || subtle.ConstantTimeCompare([]byte(c.Value), []byte(token)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		// Las órdenes que cambian datos solo se aceptan desde nuestra propia página.
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if o := r.Header.Get("Origin"); o != "" && !strings.HasSuffix(o, r.Host) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}
