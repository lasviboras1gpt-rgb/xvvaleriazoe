package main

import "fmt"

// Event es un aviso generado por la API (apertura, confirmación, modificación...).
type Event struct {
	Key            string `json:"key"`
	Ts             int64  `json:"ts"`
	Type           string `json:"type"`
	InvitationID   string `json:"invitationId"`
	Guest          string `json:"guest"`
	Table          string `json:"table"`
	Seats          int    `json:"seats"`
	Status         string `json:"status,omitempty"`
	Count          int    `json:"count,omitempty"`
	PreviousStatus string `json:"previousStatus,omitempty"`
	PreviousCount  int    `json:"previousCount,omitempty"`
	FirstOpen      bool   `json:"firstOpen,omitempty"`
	Title          string `json:"title"`
	Text           string `json:"text"`
}

func lugares(n int) string {
	if n == 1 {
		return "1 lugar"
	}
	return fmt.Sprintf("%d lugares", n)
}

// describe rellena Title y Text en español para notificaciones y para el panel.
func describe(e *Event) {
	switch e.Type {
	case "open":
		e.Title = "Invitación abierta"
		if e.FirstOpen {
			e.Text = fmt.Sprintf("%s abrió su invitación por primera vez", e.Guest)
		} else {
			e.Text = fmt.Sprintf("%s volvió a abrir su invitación", e.Guest)
		}
	case "confirm":
		e.Title = "Asistencia confirmada"
		e.Text = fmt.Sprintf("%s confirmó %s de %d asignados", e.Guest, lugares(e.Count), e.Seats)
	case "decline":
		e.Title = "No podrá asistir"
		e.Text = fmt.Sprintf("%s avisó que no podrá asistir", e.Guest)
	case "modify":
		e.Title = "Asistencia modificada"
		switch {
		case e.Status == "declined":
			e.Text = fmt.Sprintf("%s cambió su respuesta: ya no podrá asistir", e.Guest)
		case e.PreviousStatus == "declined":
			e.Text = fmt.Sprintf("%s cambió su respuesta: ahora asistirá con %s", e.Guest, lugares(e.Count))
		default:
			e.Text = fmt.Sprintf("%s cambió de %s a %s", e.Guest, lugares(e.PreviousCount), lugares(e.Count))
		}
	default:
		e.Title = "Novedad"
		e.Text = e.Guest
	}
}
