package main

import "testing"

func TestValidateFEN(t *testing.T) {
	tests := []struct {
		name    string
		fen     string
		wantErr bool
	}{
		{"starting position", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", false},
		{"after e4", "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1", false},
		{"empty board", "8/8/8/8/8/8/8/8 w - - 0 1", false},
		{"missing ranks", "rnbqkbnr/pppppppp/8/8 w KQkq - 0 1", true},
		{"invalid characters", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBXKBNR w KQkq - 0 1", true},
		{"empty string", "", true},
		{"too many squares", "rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateFEN(tt.fen)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateFEN(%q) error = %v, wantErr %v", tt.fen, err, tt.wantErr)
			}
		})
	}
}

func TestParseInfoLine(t *testing.T) {
	tests := []struct {
		name      string
		line      string
		wantDepth int
		wantScore Score
		wantPV    bool
	}{
		{
			"standard info",
			"info depth 20 multipv 1 score cp 35 nodes 1234567 nps 2000000 pv e2e4 e7e5",
			20,
			Score{Type: "cp", Value: 35},
			true,
		},
		{
			"mate score",
			"info depth 15 score mate 3 pv e2e4",
			15,
			Score{Type: "mate", Value: 3},
			true,
		},
		{
			"no pv line",
			"info depth 10 score cp 0 nodes 100",
			0,
			Score{},
			false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg := parseInfoLine(tt.line)
			if tt.wantPV {
				if msg == nil {
					t.Fatal("expected message, got nil")
				}
				if msg.Depth != tt.wantDepth {
					t.Errorf("depth = %d, want %d", msg.Depth, tt.wantDepth)
				}
				if msg.Score != tt.wantScore {
					t.Errorf("score = %+v, want %+v", msg.Score, tt.wantScore)
				}
			} else {
				if msg != nil {
					t.Errorf("expected nil, got %+v", msg)
				}
			}
		})
	}
}
