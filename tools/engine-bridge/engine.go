package main

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

type Engine struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	stdout    *bufio.Scanner
	mu        sync.Mutex
	name      string
	analyzing bool
	analyzeMu sync.Mutex
}

func NewEngine(path string, options map[string]string) (*Engine, error) {
	// Resolve full path for logging
	resolvedPath, lookErr := exec.LookPath(path)
	if lookErr != nil {
		resolvedPath = path
	}
	log.Printf("Engine binary: %s (resolved: %s)", path, resolvedPath)

	cmd := exec.Command(path)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start engine: %w", err)
	}

	e := &Engine{
		cmd:    cmd,
		stdin:  stdin,
		stdout: bufio.NewScanner(stdout),
	}

	// Initialize UCI
	e.send("uci")
	name := "Unknown Engine"
	for e.stdout.Scan() {
		line := e.stdout.Text()
		if strings.HasPrefix(line, "id name ") {
			name = strings.TrimPrefix(line, "id name ")
		}
		if line == "uciok" {
			break
		}
	}
	e.name = name

	// Set options
	for k, v := range options {
		e.send(fmt.Sprintf("setoption name %s value %s", k, v))
	}

	e.send("isready")
	for e.stdout.Scan() {
		if e.stdout.Text() == "readyok" {
			break
		}
	}

	log.Printf("Engine ready: %s", name)
	return e, nil
}

func (e *Engine) Name() string {
	return e.name
}

func (e *Engine) send(cmd string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	log.Printf("[UCI >>] %s", cmd)
	fmt.Fprintln(e.stdin, cmd)
}

func (e *Engine) SetOption(name, value string) {
	log.Printf("[Engine] SetOption: %s = %s", name, value)
	e.send(fmt.Sprintf("setoption name %s value %s", name, value))
}

func (e *Engine) Analyze(fen string, depth int, multiPV int, lineCb func(LineMessage), doneCb func(BestMoveMessage)) {
	// Serialize analysis — only one at a time. If a previous analysis is running,
	// stop it first (the goroutine will exit when it sees bestmove from the stop).
	e.analyzeMu.Lock()
	defer e.analyzeMu.Unlock()

	e.analyzing = true
	defer func() { e.analyzing = false }()

	if multiPV > 1 {
		e.send(fmt.Sprintf("setoption name MultiPV value %d", multiPV))
	}

	e.send(fmt.Sprintf("position fen %s", fen))

	depthStr := ""
	if depth > 0 {
		depthStr = fmt.Sprintf(" depth %d", depth)
	}
	e.send(fmt.Sprintf("go%s", depthStr))

	for e.stdout.Scan() {
		line := e.stdout.Text()
		log.Printf("[UCI <<] %s", line)

		if strings.HasPrefix(line, "info ") && strings.Contains(line, " pv ") {
			msg := parseInfoLine(line)
			if msg != nil {
				lineCb(*msg)
			}
		}

		if strings.HasPrefix(line, "bestmove ") {
			parts := strings.Fields(line)
			msg := BestMoveMessage{Type: "bestmove", Move: parts[1]}
			if len(parts) >= 4 && parts[2] == "ponder" {
				msg.Ponder = parts[3]
			}
			doneCb(msg)
			return
		}
	}
}

func (e *Engine) Stop() {
	if e.analyzing {
		log.Println("[Engine] Sending stop to UCI engine")
		e.send("stop")
	} else {
		log.Println("[Engine] Stop requested but not analyzing — ignored")
	}
}

func (e *Engine) Close() {
	e.send("quit")
	_ = e.stdin.Close()
	_ = e.cmd.Wait()
}

func parseInfoLine(line string) *LineMessage {
	fields := strings.Fields(line)
	msg := &LineMessage{Type: "line"}

	for i := 1; i < len(fields); i++ {
		switch fields[i] {
		case "depth":
			if i+1 < len(fields) {
				msg.Depth, _ = strconv.Atoi(fields[i+1])
				i++
			}
		case "multipv":
			if i+1 < len(fields) {
				msg.MultiPV, _ = strconv.Atoi(fields[i+1])
				i++
			}
		case "score":
			if i+2 < len(fields) {
				msg.Score.Type = fields[i+1]
				msg.Score.Value, _ = strconv.Atoi(fields[i+2])
				i += 2
			}
		case "nodes":
			if i+1 < len(fields) {
				msg.Nodes, _ = strconv.ParseInt(fields[i+1], 10, 64)
				i++
			}
		case "nps":
			if i+1 < len(fields) {
				msg.NPS, _ = strconv.ParseInt(fields[i+1], 10, 64)
				i++
			}
		case "pv":
			msg.PV = strings.Join(fields[i+1:], " ")
			return msg
		}
	}

	if msg.PV == "" {
		return nil
	}
	return msg
}
