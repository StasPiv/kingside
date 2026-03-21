package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfig_GeneratesSecretOnMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig error: %v", err)
	}

	if len(cfg.Secret) != 32 {
		t.Errorf("secret length = %d, want 32", len(cfg.Secret))
	}

	if cfg.Port != 9090 {
		t.Errorf("port = %d, want 9090", cfg.Port)
	}

	// File should be created
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Error("config file was not created")
	}
}

func TestLoadConfig_LoadsExisting(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	content := `port: 8080
secret: "abcdef0123456789abcdef0123456789"
engine_path: "/usr/bin/stockfish"
options:
  Threads: "4"
  Hash: "512"
`
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig error: %v", err)
	}

	if cfg.Port != 8080 {
		t.Errorf("port = %d, want 8080", cfg.Port)
	}
	if cfg.Secret != "abcdef0123456789abcdef0123456789" {
		t.Errorf("secret = %s", cfg.Secret)
	}
	if cfg.Options["Threads"] != "4" {
		t.Errorf("Threads = %s, want 4", cfg.Options["Threads"])
	}
}

func TestGenerateSecret(t *testing.T) {
	s1 := generateSecret()
	s2 := generateSecret()

	if len(s1) != 32 {
		t.Errorf("secret length = %d, want 32", len(s1))
	}
	if s1 == s2 {
		t.Error("two secrets should not be equal")
	}
}
