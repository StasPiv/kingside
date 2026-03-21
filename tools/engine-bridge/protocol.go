package main

import (
	"fmt"
	"regexp"
	"strings"
)

// --- Client -> Bridge messages ---

type ClientMessage struct {
	Type    string `json:"type"`
	FEN     string `json:"fen,omitempty"`
	Depth   int    `json:"depth,omitempty"`
	MultiPV int    `json:"multiPv,omitempty"`
	Name    string `json:"name,omitempty"`
	Value   string `json:"value,omitempty"`
}

// --- Bridge -> Client messages ---

type LineMessage struct {
	Type    string `json:"type"`
	Depth   int    `json:"depth"`
	MultiPV int    `json:"multipv"`
	Score   Score  `json:"score"`
	PV      string `json:"pv"`
	Nodes   int64  `json:"nodes"`
	NPS     int64  `json:"nps"`
}

type Score struct {
	Type  string `json:"type"` // "cp" or "mate"
	Value int    `json:"value"`
}

type BestMoveMessage struct {
	Type   string `json:"type"`
	Move   string `json:"move"`
	Ponder string `json:"ponder,omitempty"`
}

type EngineInfoMessage struct {
	Type      string `json:"type"`
	Name      string `json:"name"`
	ID        string `json:"id,omitempty"`
	Analyzing bool   `json:"analyzing"`
}

type ErrorMessage struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

type PongMessage struct {
	Type string `json:"type"`
}

// --- FEN validation ---

var fenRegex = regexp.MustCompile(
	`^[rnbqkpRNBQKP1-8/]+ [wb] [KQkq-]+ [a-h1-8-]+ \d+ \d+$`,
)

func ValidateFEN(fen string) error {
	fen = strings.TrimSpace(fen)
	if !fenRegex.MatchString(fen) {
		return fmt.Errorf("invalid FEN format")
	}

	parts := strings.Split(fen, " ")
	ranks := strings.Split(parts[0], "/")
	if len(ranks) != 8 {
		return fmt.Errorf("FEN must have 8 ranks, got %d", len(ranks))
	}

	for i, rank := range ranks {
		count := 0
		for _, ch := range rank {
			if ch >= '1' && ch <= '8' {
				count += int(ch - '0')
			} else {
				count++
			}
		}
		if count != 8 {
			return fmt.Errorf("rank %d has %d squares, expected 8", 8-i, count)
		}
	}

	return nil
}
