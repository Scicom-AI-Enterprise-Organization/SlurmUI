package handler

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
	"github.com/scicom/aura/agent/internal/message"
	agentNats "github.com/scicom/aura/agent/internal/nats"
)

// appSession holds a running interactive app.
type appSession struct {
	ptmx *os.File   // PTY master (shell)
	cmd  *exec.Cmd
	done chan struct{}
}

// AppHandler manages interactive app sessions (shell, Jupyter).
type AppHandler struct {
	mu        sync.Mutex
	sessions  map[string]*appSession
	publisher *agentNats.Publisher
	logger    *slog.Logger
}

func NewAppHandler(publisher *agentNats.Publisher, logger *slog.Logger) *AppHandler {
	return &AppHandler{
		sessions:  make(map[string]*appSession),
		publisher: publisher,
		logger:    logger,
	}
}

// HandleLaunchApp starts a shell (srun --pty bash) or a Jupyter server.
func (h *AppHandler) HandleLaunchApp(ctx context.Context, cmd *message.Command) error {
	var payload message.LaunchAppPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid launch_app payload: %w", err))
	}

	h.logger.Info("launching app", "request_id", cmd.RequestID, "type", payload.AppType)

	switch payload.AppType {
	case "shell":
		return h.launchShell(ctx, cmd.RequestID, payload)
	case "jupyter":
		return h.launchJupyter(ctx, cmd.RequestID, payload)
	default:
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("unknown app_type: %s", payload.AppType))
	}
}

// launchShell starts an interactive bash session via srun --pty.
func (h *AppHandler) launchShell(ctx context.Context, sessionID string, payload message.LaunchAppPayload) error {
	seq := 0
	emit := func(line string) {
		_ = h.publisher.SendStreamLine(sessionID, line, seq)
		seq++
	}

	// Build the srun command — runs as the provisioned user on a compute node.
	nodes := payload.Nodes
	if nodes <= 0 {
		nodes = 1
	}
	cpusPerNode := payload.CpusPerNode
	if cpusPerNode <= 0 {
		cpusPerNode = 1
	}
	timeLimit := payload.TimeLimit
	if timeLimit == "" {
		timeLimit = "2:00:00"
	}

	var srunArgs []string
	if payload.Partition != "" {
		srunArgs = append(srunArgs, "--partition="+payload.Partition)
	}
	srunArgs = append(srunArgs,
		fmt.Sprintf("--nodes=%d", nodes),
		fmt.Sprintf("--cpus-per-task=%d", cpusPerNode),
		"--ntasks-per-node=1",
		"--time="+timeLimit,
	)
	if payload.GpusPerNode > 0 {
		srunArgs = append(srunArgs, fmt.Sprintf("--gpus-per-node=%d", payload.GpusPerNode))
	}
	srunArgs = append(srunArgs, "--pty", "/bin/bash", "--login")

	var c *exec.Cmd
	if payload.Username != "" {
		args := append([]string{"-u", payload.Username, "srun"}, srunArgs...)
		c = exec.CommandContext(ctx, "sudo", args...)
	} else {
		c = exec.CommandContext(ctx, "srun", srunArgs...)
	}

	// Set HOME so bash --login finds the right profile.
	if payload.NfsHome != "" {
		c.Env = append(os.Environ(), "HOME="+payload.NfsHome)
	}

	ptmx, err := pty.Start(c)
	if err != nil {
		return h.publisher.SendError(sessionID, fmt.Errorf("failed to start shell: %w", err))
	}

	session := &appSession{ptmx: ptmx, cmd: c, done: make(chan struct{})}
	h.mu.Lock()
	h.sessions[sessionID] = session
	h.mu.Unlock()

	emit("[aura] Shell session started")

	// Stream PTY output until process exits.
	go func() {
		defer func() {
			ptmx.Close()
			h.mu.Lock()
			delete(h.sessions, sessionID)
			h.mu.Unlock()
			close(session.done)
		}()

		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				encoded := base64.StdEncoding.EncodeToString(buf[:n])
				_ = h.publisher.SendStreamLine(sessionID, "__PTY__:"+encoded, seq)
				seq++
			}
			if err != nil {
				break
			}
		}
		// Wait for process exit code.
		exitCode := 0
		if err := c.Wait(); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			}
		}
		_ = h.publisher.SendResult(sessionID, map[string]interface{}{
			"exit_code": exitCode,
			"type":      "shell_exit",
		})
	}()

	return nil
}

// launchJupyter starts a Jupyter Notebook server on the controller node.
func (h *AppHandler) launchJupyter(ctx context.Context, sessionID string, payload message.LaunchAppPayload) error {
	port, err := findFreePort(8888, 8999)
	if err != nil {
		return h.publisher.SendError(sessionID, fmt.Errorf("no free port available (8888–8999): %w", err))
	}

	token, err := randomHex(16)
	if err != nil {
		return h.publisher.SendError(sessionID, fmt.Errorf("failed to generate token: %w", err))
	}

	notebookDir := payload.NfsHome
	if notebookDir == "" {
		notebookDir = "/tmp"
	}

	var c *exec.Cmd
	jupyterArgs := []string{
		"notebook",
		"--no-browser",
		"--ip=0.0.0.0",
		fmt.Sprintf("--port=%d", port),
		"--NotebookApp.token=" + token,
		"--NotebookApp.allow_origin=*",
		"--notebook-dir=" + notebookDir,
	}
	if payload.Username != "" {
		args := append([]string{"-u", payload.Username, "jupyter"}, jupyterArgs...)
		c = exec.CommandContext(ctx, "sudo", args...)
	} else {
		c = exec.CommandContext(ctx, "jupyter", jupyterArgs...)
	}

	// Capture both stdout and stderr to detect the startup URL.
	pr, pw, err := os.Pipe()
	if err != nil {
		return h.publisher.SendError(sessionID, fmt.Errorf("failed to create pipe: %w", err))
	}
	c.Stdout = pw
	c.Stderr = pw

	if err := c.Start(); err != nil {
		pr.Close()
		pw.Close()
		return h.publisher.SendError(sessionID, fmt.Errorf("failed to start Jupyter: %w", err))
	}
	pw.Close()

	session := &appSession{cmd: c, done: make(chan struct{})}
	h.mu.Lock()
	h.sessions[sessionID] = session
	h.mu.Unlock()

	// Build the access URL now — we know the port and token.
	host := payload.ControllerHost
	if host == "" {
		host = "localhost"
	}
	accessURL := fmt.Sprintf("http://%s:%d?token=%s", host, port, token)

	// Stream output and wait for Jupyter to confirm it started.
	go func() {
		defer func() {
			pr.Close()
			h.mu.Lock()
			delete(h.sessions, sessionID)
			h.mu.Unlock()
			close(session.done)
		}()

		scanner := bufio.NewScanner(pr)
		for scanner.Scan() {
			line := scanner.Text()
			// Stream lines to NATS so the browser can see startup logs.
			_ = h.publisher.SendStreamLine(sessionID, line, 0)
		}
		c.Wait()
	}()

	// Return the URL immediately — the server may still be starting up,
	// but the token and port are known and the URL is stable.
	return h.publisher.SendResult(sessionID, map[string]interface{}{
		"type":       "jupyter_started",
		"access_url": accessURL,
		"port":       port,
		"token":      token,
		"note":       fmt.Sprintf("Ensure port %d is open on the controller node's firewall/security group.", port),
	})
}

// HandleAppInput writes data to the PTY of an active shell session.
func (h *AppHandler) HandleAppInput(ctx context.Context, cmd *message.Command) error {
	var payload message.AppInputPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid app_input payload: %w", err))
	}

	h.mu.Lock()
	session, ok := h.sessions[payload.SessionID]
	h.mu.Unlock()

	if !ok {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("session not found: %s", payload.SessionID))
	}
	if session.ptmx == nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("session has no PTY (not a shell session)"))
	}

	data, err := base64.StdEncoding.DecodeString(payload.Data)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid base64 input: %w", err))
	}

	if _, err := session.ptmx.Write(data); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("write to PTY failed: %w", err))
	}

	return h.publisher.SendResult(cmd.RequestID, map[string]interface{}{"ok": true})
}

// HandleAppResize resizes the PTY window.
func (h *AppHandler) HandleAppResize(ctx context.Context, cmd *message.Command) error {
	var payload message.AppResizePayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid app_resize payload: %w", err))
	}

	h.mu.Lock()
	session, ok := h.sessions[payload.SessionID]
	h.mu.Unlock()

	if !ok || session.ptmx == nil {
		// Not an error — session may have just exited.
		return h.publisher.SendResult(cmd.RequestID, map[string]interface{}{"ok": false})
	}

	if err := pty.Setsize(session.ptmx, &pty.Winsize{
		Rows: payload.Rows,
		Cols: payload.Cols,
	}); err != nil {
		h.logger.Warn("PTY resize failed", "error", err)
	}

	return h.publisher.SendResult(cmd.RequestID, map[string]interface{}{"ok": true})
}

// HandleKillApp terminates an active app session.
func (h *AppHandler) HandleKillApp(ctx context.Context, cmd *message.Command) error {
	var payload message.KillAppPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid kill_app payload: %w", err))
	}

	h.mu.Lock()
	session, ok := h.sessions[payload.SessionID]
	if ok {
		delete(h.sessions, payload.SessionID)
	}
	h.mu.Unlock()

	if ok && session.cmd != nil && session.cmd.Process != nil {
		_ = session.cmd.Process.Kill()
		if session.ptmx != nil {
			_ = session.ptmx.Close()
		}
	}

	return h.publisher.SendResult(cmd.RequestID, map[string]interface{}{"ok": true})
}

// findFreePort returns the first unused TCP port in [start, end].
func findFreePort(start, end int) (int, error) {
	for port := start; port <= end; port++ {
		ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
		if err == nil {
			ln.Close()
			return port, nil
		}
	}
	return 0, fmt.Errorf("no free port in range %d-%d", start, end)
}

// randomHex returns n random hex bytes.
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// ioReadAll is a helper used to satisfy the import of io.
var _ = io.EOF
