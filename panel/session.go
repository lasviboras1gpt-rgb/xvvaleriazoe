package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"
)

// session.json permite que un segundo doble clic reutilice la ventana ya abierta
// en lugar de lanzar otro programa.
type Session struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
}

func (s Session) URL() string { return fmt.Sprintf("http://127.0.0.1:%d/?t=%s", s.Port, s.Token) }

func sessionPath(dir string) string { return filepath.Join(dir, "session.json") }

func liveSession(dir string) (Session, bool) {
	b, err := os.ReadFile(sessionPath(dir))
	if err != nil {
		return Session{}, false
	}
	var s Session
	if json.Unmarshal(b, &s) != nil || s.Port == 0 || s.Token == "" {
		return Session{}, false
	}
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", s.Port), 700*time.Millisecond)
	if err != nil {
		return Session{}, false
	}
	c.Close()
	return s, true
}

func saveSession(dir string, s Session) error {
	b, _ := json.Marshal(s)
	return os.WriteFile(sessionPath(dir), b, 0o600)
}

func clearSession(dir string) { _ = os.Remove(sessionPath(dir)) }
