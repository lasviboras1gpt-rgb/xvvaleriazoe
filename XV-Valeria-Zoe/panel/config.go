package main

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Config se guarda en %AppData%\XV-Valeria-Zoe\config.json. Solo contiene la dirección del sitio:
// la clave de administración va incrustada en el programa (no hay que escribir contraseña).
type Config struct {
	Site     string `json:"site"`
	LastSeen string `json:"lastSeen"`
}

type ConfigStore struct {
	mu   sync.Mutex
	path string
	cfg  Config
}

func dataDir() string {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "XV-Valeria-Zoe")
}

func loadConfig(dir string) *ConfigStore {
	s := &ConfigStore{path: filepath.Join(dir, "config.json")}
	if b, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(b, &s.cfg)
	}
	return s
}

func (s *ConfigStore) Get() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg
}

func (s *ConfigStore) Update(fn func(*Config)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(&s.cfg)
	b, err := json.MarshalIndent(s.cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// normalizeSite acepta "mi-sitio.netlify.app" o "https://mi-sitio.netlify.app/" y devuelve
// la URL base limpia. Para localhost usa http; para el resto https.
func normalizeSite(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", false
	}
	if !strings.Contains(raw, "://") {
		host := strings.Split(raw, "/")[0]
		h := strings.Split(host, ":")[0]
		if h == "localhost" || h == "127.0.0.1" {
			raw = "http://" + raw
		} else {
			raw = "https://" + raw
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", false
	}
	return strings.TrimRight(u.Scheme+"://"+u.Host+u.Path, "/"), true
}
