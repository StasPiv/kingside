package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net/http"
)

func main() {
	configPath := flag.String("config", "config.yaml", "path to config file")
	flag.Parse()

	cfg, err := LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("Config error: %v", err)
	}

	log.Printf("Config: %s", *configPath)
	log.Printf("Engine path: %s", cfg.EnginePath)
	log.Printf("Port: %d", cfg.Port)
	log.Printf("Secret key: %s", cfg.Secret)
	log.Printf("  (connect with: ws://localhost:%d/ws?key=%s)", cfg.Port, cfg.Secret)

	engine, err := NewEngine(cfg.EnginePath, cfg.Options)
	if err != nil {
		log.Fatalf("Engine error: %v", err)
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
			log.Fatalf("TLS error: %v", err)
		}

		server := &http.Server{
			Addr:    addr,
			Handler: mux,
			TLSConfig: &tls.Config{
				Certificates: []tls.Certificate{tlsCert},
			},
		}
		log.Printf("Listening on wss://localhost%s/ws", addr)
		log.Fatal(server.ListenAndServeTLS("", ""))
	} else {
		log.Printf("Listening on ws://localhost%s/ws", addr)
		log.Fatal(http.ListenAndServe(addr, mux))
	}
}
