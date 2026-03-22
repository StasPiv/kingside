package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// isLocalhost checks if the remote address is a loopback connection.
// addr may include port, e.g. "[::1]:56814" or "127.0.0.1:9090".
func isLocalhost(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Server struct {
	cfg    Config
	engine *Engine

	// Rate limiting
	connAttempts map[string][]time.Time
	bannedIPs    map[string]time.Time
	rateMu       sync.Mutex

	// Single active connection
	activeConn   *websocket.Conn
	connClosed   bool
	activeMu     sync.Mutex

	// Last analysis params for restart after setoption
	lastFEN     string
	lastDepth   int
	lastMultiPV int

	// Grace period timer for disconnect
	disconnectTimer *time.Timer
}

func NewServer(cfg Config, engine *Engine) *Server {
	return &Server{
		cfg:          cfg,
		engine:       engine,
		connAttempts: make(map[string][]time.Time),
		bannedIPs:    make(map[string]time.Time),
	}
}

func (s *Server) HandleWS(w http.ResponseWriter, r *http.Request) {
	ip := r.RemoteAddr

	// Check ban
	s.rateMu.Lock()
	if banTime, ok := s.bannedIPs[ip]; ok {
		if time.Since(banTime) < 10*time.Minute {
			s.rateMu.Unlock()
			http.Error(w, "banned", http.StatusForbidden)
			return
		}
		delete(s.bannedIPs, ip)
	}

	// Rate limit
	now := time.Now()
	attempts := s.connAttempts[ip]
	var recent []time.Time
	for _, t := range attempts {
		if now.Sub(t) < time.Minute {
			recent = append(recent, t)
		}
	}
	recent = append(recent, now)
	s.connAttempts[ip] = recent

	if len(recent) > s.cfg.RateLimit.MaxPerMinute {
		if len(recent) > s.cfg.RateLimit.BanAfter {
			s.bannedIPs[ip] = now
			log.Printf("Banned IP %s", ip)
		}
		s.rateMu.Unlock()
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	s.rateMu.Unlock()

	// Auth — skip for localhost connections
	key := r.URL.Query().Get("key")
	if key != s.cfg.Secret && !isLocalhost(ip) {
		log.Printf("Auth failed from %s", ip)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Upgrade error: %v", err)
		return
	}

	// Close previous connection, cancel disconnect timer
	s.activeMu.Lock()
	if s.disconnectTimer != nil {
		s.disconnectTimer.Stop()
		s.disconnectTimer = nil
		log.Println("Reconnect within grace period — engine kept running")
	}
	if s.activeConn != nil {
		_ = s.activeConn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(4000, "replaced by new connection"))
		_ = s.activeConn.Close()
	}
	s.activeConn = conn
	s.connClosed = false
	s.activeMu.Unlock()

	log.Printf("Client connected from %s", ip)

	// Send engine info with current analysis state
	s.sendJSON(conn, EngineInfoMessage{
		Type:      "engine_info",
		Name:      s.engine.Name(),
		Analyzing: s.engine.analyzing,
	})

	s.handleMessages(conn)
}

const disconnectGracePeriod = 5 * time.Second

func (s *Server) handleMessages(conn *websocket.Conn) {
	defer func() {
		s.activeMu.Lock()
		if s.activeConn == conn {
			s.activeConn = nil
			s.connClosed = true

			// Grace period: don't stop engine immediately — wait for reconnect
			if s.engine.analyzing {
				log.Printf("Client disconnected — engine keeps running for %v (grace period)", disconnectGracePeriod)
				s.disconnectTimer = time.AfterFunc(disconnectGracePeriod, func() {
					log.Println("Grace period expired — stopping engine")
					s.engine.Stop()
				})
			} else {
				log.Println("Client disconnected (engine idle)")
			}
		}
		s.activeMu.Unlock()

		_ = conn.Close()
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}

		var msg ClientMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			log.Printf("[WS <<] invalid JSON: %s", string(raw))
			s.sendJSON(conn, ErrorMessage{Type: "error", Message: "invalid JSON"})
			continue
		}

		log.Printf("[WS <<] type=%s fen=%s depth=%d multiPv=%d name=%s value=%s",
			msg.Type, truncate(msg.FEN, 40), msg.Depth, msg.MultiPV, msg.Name, msg.Value)

		switch msg.Type {
		case "analyze", "evaluate":
			s.handleAnalyze(conn, msg)
		case "stop":
			s.engine.Stop()
		case "setoption":
			if msg.Name != "" {
				s.handleSetOption(conn, msg.Name, msg.Value)
			}
		case "ping":
			s.sendJSON(conn, PongMessage{Type: "pong"})
		case "info":
			s.sendJSON(conn, EngineInfoMessage{
				Type:      "engine_info",
				Name:      s.engine.Name(),
				Analyzing: s.engine.analyzing,
			})
		default:
			s.sendJSON(conn, ErrorMessage{Type: "error", Message: "unknown message type: " + msg.Type})
		}
	}
}

func (s *Server) handleAnalyze(conn *websocket.Conn, msg ClientMessage) {
	if msg.FEN == "" {
		s.sendJSON(conn, ErrorMessage{Type: "error", Message: "FEN is required"})
		return
	}

	if err := ValidateFEN(msg.FEN); err != nil {
		s.sendJSON(conn, ErrorMessage{Type: "error", Message: "invalid FEN: " + err.Error()})
		return
	}

	depth := msg.Depth
	if depth <= 0 {
		depth = 30
	}
	multiPV := msg.MultiPV
	if multiPV <= 0 {
		multiPV = 1
	}

	// Track for restart after setoption
	s.lastFEN = msg.FEN
	s.lastDepth = depth
	s.lastMultiPV = multiPV

	go s.engine.Analyze(
		msg.FEN, depth, multiPV,
		func(line LineMessage) { s.sendToActive(line) },
		func(bm BestMoveMessage) { s.sendToActive(bm) },
	)
}

func (s *Server) handleSetOption(conn *websocket.Conn, name, value string) {
	wasAnalyzing := s.engine.analyzing

	if wasAnalyzing {
		log.Printf("[Engine] Stopping analysis to apply setoption %s=%s", name, value)
		// Stop will cause the Analyze goroutine to receive bestmove and exit.
		// We send stop and wait for the goroutine to release analyzeMu.
		s.engine.send("stop")
		// Wait for analyzeMu — Analyze goroutine will unlock it after receiving bestmove
		s.engine.analyzeMu.Lock()
		s.engine.analyzeMu.Unlock()
	}

	s.engine.SetOption(name, value)

	if wasAnalyzing && s.lastFEN != "" {
		log.Printf("[Engine] Restarting analysis after setoption")
		go s.engine.Analyze(
			s.lastFEN, s.lastDepth, s.lastMultiPV,
			func(line LineMessage) { s.sendToActive(line) },
			func(bm BestMoveMessage) { s.sendToActive(bm) },
		)
	}
}

// sendToActive sends to whichever connection is currently active.
// Used by Analyze callbacks so that after reconnect, lines go to the new connection.
func (s *Server) sendToActive(v interface{}) {
	s.activeMu.Lock()
	conn := s.activeConn
	closed := s.connClosed
	s.activeMu.Unlock()

	if conn == nil || closed {
		return
	}
	s.sendJSON(conn, v)
}

func (s *Server) sendJSON(conn *websocket.Conn, v interface{}) {
	s.activeMu.Lock()
	defer s.activeMu.Unlock()

	// Don't write to a connection that's no longer active
	if s.activeConn != conn || s.connClosed {
		return
	}

	if err := conn.WriteJSON(v); err != nil {
		// Silence "close sent" errors — normal when client disconnects during analysis
		if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
			return
		}
		errStr := err.Error()
		if errStr == "websocket: close sent" || errStr == "websocket: close 1000 (normal)" {
			return
		}
		log.Printf("Write error: %v", err)
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
