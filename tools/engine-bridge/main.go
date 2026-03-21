package main

import (
	"bufio"
	"crypto/tls"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
)

func main() {
	configPath := flag.String("config", "config.yaml", "path to config file")
	logFile := flag.String("log", "", "path to log file (default: stdout)")
	flag.Parse()

	// Set up logging to file if specified, or to both stdout and file on Windows
	if *logFile != "" {
		setupFileLogging(*logFile)
	} else if runtime.GOOS == "windows" {
		// On Windows, also log to bridge.log by default (console may close on error)
		setupFileLogging("bridge.log")
	}

	log.Printf("=== kingside-engine-bridge starting ===")
	log.Printf("OS: %s/%s", runtime.GOOS, runtime.GOARCH)

	cfg, err := LoadConfig(*configPath)
	if err != nil {
		log.Printf("Config error: %v", err)
		waitOnWindows()
		os.Exit(1)
	}

	log.Printf("Config: %s", *configPath)
	log.Printf("Engine path: %s", cfg.EnginePath)
	log.Printf("Port: %d", cfg.Port)
	log.Printf("Secret key: %s", cfg.Secret)
	log.Printf("  → Connect URL: ws://localhost:%d/ws?key=%s", cfg.Port, cfg.Secret)

	engine, err := NewEngine(cfg.EnginePath, cfg.Options)
	if err != nil {
		log.Printf("Engine error: %v", err)
		log.Printf("Make sure the chess engine binary is installed and accessible.")
		if runtime.GOOS == "windows" {
			log.Printf("On Windows, ensure stockfish.exe is in PATH or set engine_path in config.yaml")
		}
		waitOnWindows()
		os.Exit(1)
	}
	defer engine.Close()

	srv := NewServer(cfg, engine)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", srv.HandleWS)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","engine":"%s"}`, engine.Name())
	})

	addr := fmt.Sprintf(":%d", cfg.Port)

	if cfg.TLS != nil && cfg.TLS.Enabled {
		var tlsCert tls.Certificate
		if cfg.TLS.CertFile != "" && cfg.TLS.KeyFile != "" {
			tlsCert, err = tls.LoadX509KeyPair(cfg.TLS.CertFile, cfg.TLS.KeyFile)
		} else {
			log.Println("TLS enabled with self-signed certificate")
			tlsCert, err = GenerateSelfSignedCert()
		}
		if err != nil {
			log.Printf("TLS error: %v", err)
			waitOnWindows()
			os.Exit(1)
		}

		server := &http.Server{
			Addr:    addr,
			Handler: mux,
			TLSConfig: &tls.Config{
				Certificates: []tls.Certificate{tlsCert},
			},
		}
		log.Printf("Listening on wss://localhost%s/ws", addr)
		if err := server.ListenAndServeTLS("", ""); err != nil {
			log.Printf("Server error: %v", err)
			waitOnWindows()
			os.Exit(1)
		}
	} else {
		log.Printf("Listening on ws://localhost%s/ws", addr)
		if err := http.ListenAndServe(addr, mux); err != nil {
			log.Printf("Server error: %v", err)
			waitOnWindows()
			os.Exit(1)
		}
	}
}

// setupFileLogging configures log output to both stdout and a file.
func setupFileLogging(path string) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		log.Printf("Warning: cannot open log file %s: %v", path, err)
		return
	}
	// Write to both stdout and file
	multi := io.MultiWriter(os.Stdout, f)
	log.SetOutput(multi)
	log.Printf("Logging to %s", path)
}

// waitOnWindows pauses before exit on Windows so the user can see the error.
func waitOnWindows() {
	if runtime.GOOS == "windows" {
		fmt.Println("\nPress Enter to exit...")
		bufio.NewReader(os.Stdin).ReadBytes('\n')
	}
}
