package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Port       int               `yaml:"port"`
	Secret     string            `yaml:"secret"`
	EnginePath string            `yaml:"engine_path"`
	Options    map[string]string `yaml:"options"`
	TLS        *TLSConfig        `yaml:"tls,omitempty"`
	RateLimit  RateLimitConfig   `yaml:"rate_limit"`
}

type TLSConfig struct {
	Enabled  bool   `yaml:"enabled"`
	CertFile string `yaml:"cert_file"`
	KeyFile  string `yaml:"key_file"`
}

type RateLimitConfig struct {
	MaxPerMinute int `yaml:"max_per_minute"`
	BanAfter     int `yaml:"ban_after"`
}

func DefaultConfig() Config {
	return Config{
		Port:       9090,
		Secret:     "",
		EnginePath: "stockfish",
		Options:    map[string]string{"Threads": "1", "Hash": "256"},
		RateLimit:  RateLimitConfig{MaxPerMinute: 5, BanAfter: 10},
	}
}

func LoadConfig(path string) (Config, error) {
	cfg := DefaultConfig()

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			cfg.Secret = generateSecret()
			return cfg, saveConfig(path, cfg)
		}
		return cfg, fmt.Errorf("read config: %w", err)
	}

	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("parse config: %w", err)
	}

	if cfg.Secret == "" {
		cfg.Secret = generateSecret()
		if err := saveConfig(path, cfg); err != nil {
			return cfg, fmt.Errorf("save generated secret: %w", err)
		}
	}

	return cfg, nil
}

func saveConfig(path string, cfg Config) error {
	// Write human-readable config with comments
	content := fmt.Sprintf(`# kingside-engine-bridge configuration
# Generated automatically on first run

port: %d

# Secret key for WebSocket authentication.
# Use this key when connecting: ws://localhost:%d/ws?key=YOUR_SECRET
# Copy this value to the frontend engine settings.
secret: "%s"

# Path to UCI chess engine binary (e.g. stockfish, lc0)
engine_path: "%s"

# UCI engine options (sent as "setoption name X value Y" on startup)
# Adjust Threads to match your CPU cores for best performance
options:
`, cfg.Port, cfg.Port, cfg.Secret, cfg.EnginePath)

	for k, v := range cfg.Options {
		content += fmt.Sprintf("  %s: \"%s\"\n", k, v)
	}

	content += fmt.Sprintf(`
# Rate limiting
rate_limit:
  max_per_minute: %d
  ban_after: %d
`, cfg.RateLimit.MaxPerMinute, cfg.RateLimit.BanAfter)

	return os.WriteFile(path, []byte(content), 0600)
}

func generateSecret() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}
