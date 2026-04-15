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
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/scicom/aura/agent/internal/message"
	agentNats "github.com/scicom/aura/agent/internal/nats"
)

// appSession holds a running interactive app.
type appSession struct {
	ptmx    *os.File     // PTY master (shell)
	cmd     *exec.Cmd
	done    chan struct{}
	proxyLn net.Listener // TCP proxy listener (Jupyter)
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

// launchShell starts an interactive bash session using salloc to reserve a full
// resource block (N nodes × C CPUs × G GPUs), then runs `srun --pty bash` as a
// step inside that allocation. The user lands on one compute node; from there they
// can launch additional `srun` steps that span all allocated nodes. cgroups
// constrain the shell to exactly the requested CPUs so htop / free -m reflect the
// reserved resources.
func (h *AppHandler) launchShell(ctx context.Context, sessionID string, payload message.LaunchAppPayload) error {
	seq := 0
	emit := func(line string) {
		_ = h.publisher.SendStreamLine(sessionID, line, seq)
		seq++
	}

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

	// salloc reserves the full allocation; `srun --pty bash` runs as a step inside it.
	sallocArgs := []string{}
	if payload.Partition != "" {
		sallocArgs = append(sallocArgs, "--partition="+payload.Partition)
	}
	sallocArgs = append(sallocArgs,
		fmt.Sprintf("--nodes=%d", nodes),
		"--ntasks-per-node=1",
		fmt.Sprintf("--cpus-per-task=%d", cpusPerNode),
		"--time="+timeLimit,
	)
	if payload.GpusPerNode > 0 {
		sallocArgs = append(sallocArgs, fmt.Sprintf("--gpus-per-node=%d", payload.GpusPerNode))
	}

	// The srun step inside salloc: --pty bash on first available node, chdir to NFS home.
	srunStep := []string{"srun", "--ntasks=1"}
	if payload.NfsHome != "" {
		srunStep = append(srunStep, "--chdir="+payload.NfsHome)
	}
	srunStep = append(srunStep, "--pty", "bash", "--login")
	sallocArgs = append(sallocArgs, srunStep...)

	var c *exec.Cmd
	if payload.Username != "" {
		args := append([]string{"-u", payload.Username, "salloc"}, sallocArgs...)
		c = exec.CommandContext(ctx, "sudo", args...)
	} else {
		c = exec.CommandContext(ctx, "salloc", sallocArgs...)
	}

	// Own process group so we can kill the whole tree on terminate.
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

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

// launchJupyter starts a Jupyter Notebook server inside a real Slurm allocation.
// It uses salloc to reserve a full resource block (N nodes × C CPUs × G GPUs),
// then runs `srun bash -c "jupyter..."` as a step on the first compute node.
// The agent starts a TCP proxy on the controller (9100–9199) forwarding to the
// compute node so the browser can reach Jupyter without direct access to the
// compute LAN. The full allocation is available for kernels / distributed work.
func (h *AppHandler) launchJupyter(ctx context.Context, sessionID string, payload message.LaunchAppPayload) error {
	// Jupyter listens on a fixed well-known port on the compute node.
	const jupyterPort = 8888

	// Reserve a proxy port on the controller.
	proxyPort, err := findFreePort(9100, 9199)
	if err != nil {
		return h.publisher.SendError(sessionID, fmt.Errorf("no free proxy port available (9100–9199): %w", err))
	}

	token, err := randomHex(16)
	if err != nil {
		return h.publisher.SendError(sessionID, fmt.Errorf("failed to generate token: %w", err))
	}

	notebookDir := payload.NfsHome
	if notebookDir == "" {
		notebookDir = "/tmp"
	}

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

	// salloc reserves the full N-node allocation.
	sallocArgs := []string{}
	if payload.Partition != "" {
		sallocArgs = append(sallocArgs, "--partition="+payload.Partition)
	}
	sallocArgs = append(sallocArgs,
		fmt.Sprintf("--nodes=%d", nodes),
		"--ntasks-per-node=1",
		fmt.Sprintf("--cpus-per-task=%d", cpusPerNode),
		"--time="+timeLimit,
	)
	if payload.GpusPerNode > 0 {
		sallocArgs = append(sallocArgs, fmt.Sprintf("--gpus-per-node=%d", payload.GpusPerNode))
	}

	// The script runs on the first compute node: announce hostname, then start Jupyter.
	script := fmt.Sprintf(
		`echo "AURA_NODE:$(hostname)" && jupyter notebook --no-browser --ip=0.0.0.0 --port=%d --NotebookApp.token=%s --NotebookApp.allow_origin='*' --notebook-dir=%s 2>&1`,
		jupyterPort, token, notebookDir,
	)
	sallocArgs = append(sallocArgs, "srun", "--ntasks=1", "bash", "-c", script)

	var c *exec.Cmd
	if payload.Username != "" {
		args := append([]string{"-u", payload.Username, "salloc"}, sallocArgs...)
		c = exec.CommandContext(ctx, "sudo", args...)
	} else {
		c = exec.CommandContext(ctx, "salloc", sallocArgs...)
	}

	// Own process group so we can kill the whole tree (salloc + srun + jupyter) on terminate.
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	pr, pw, err := os.Pipe()
	if err != nil {
		return h.publisher.SendError(sessionID, fmt.Errorf("failed to create pipe: %w", err))
	}
	c.Stdout = pw
	c.Stderr = pw

	if err := c.Start(); err != nil {
		pr.Close()
		pw.Close()
		return h.publisher.SendError(sessionID, fmt.Errorf("failed to start srun for Jupyter: %w", err))
	}
	pw.Close()

	session := &appSession{cmd: c, done: make(chan struct{})}
	h.mu.Lock()
	h.sessions[sessionID] = session
	h.mu.Unlock()

	go func() {
		defer func() {
			pr.Close()
			h.mu.Lock()
			delete(h.sessions, sessionID)
			h.mu.Unlock()
			close(session.done)
		}()

		seq := 0
		scanner := bufio.NewScanner(pr)
		var computeNode string
		var resultSent bool

		for scanner.Scan() {
			line := scanner.Text()
			_ = h.publisher.SendStreamLine(sessionID, line, seq)
			seq++

			if resultSent {
				continue
			}

			// First line printed by the srun script: the compute node hostname.
			if strings.HasPrefix(line, "AURA_NODE:") {
				computeNode = strings.TrimSpace(strings.TrimPrefix(line, "AURA_NODE:"))
				continue
			}

			// Jupyter prints a URL containing the token once it is ready.
			// Wait until we have the hostname AND Jupyter has confirmed startup.
			if computeNode != "" && strings.Contains(line, "?token=") {
				ln, err := net.Listen("tcp", fmt.Sprintf(":%d", proxyPort))
				if err != nil {
					_ = h.publisher.SendError(sessionID, fmt.Errorf("failed to start TCP proxy on :%d: %w", proxyPort, err))
					resultSent = true
					continue
				}

				h.mu.Lock()
				session.proxyLn = ln
				h.mu.Unlock()

				target := fmt.Sprintf("%s:%d", computeNode, jupyterPort)
				go proxyTCP(ln, target)

				host := payload.ControllerHost
				if host == "" {
					host = "localhost"
				}
				accessURL := fmt.Sprintf("http://%s:%d/?token=%s", host, proxyPort, token)

				_ = h.publisher.SendResult(sessionID, map[string]interface{}{
					"type":       "jupyter_ready",
					"access_url": accessURL,
					"port":       proxyPort,
					"token":      token,
				})
				resultSent = true
			}
		}

		// If srun exited before Jupyter announced itself, report the failure.
		if !resultSent {
			_ = h.publisher.SendError(sessionID, fmt.Errorf("Jupyter did not start — check that jupyter is installed on the compute node and port %d is available", jupyterPort))
		}

		c.Wait()
	}()

	return nil
}

// proxyTCP accepts connections on ln and bidirectionally proxies them to target.
func proxyTCP(ln net.Listener, target string) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return // listener was closed (session killed)
		}
		go func(c net.Conn) {
			defer c.Close()
			remote, err := net.Dial("tcp", target)
			if err != nil {
				return
			}
			defer remote.Close()
			var wg sync.WaitGroup
			wg.Add(2)
			go func() { defer wg.Done(); io.Copy(remote, c) }()
			go func() { defer wg.Done(); io.Copy(c, remote) }()
			wg.Wait()
		}(conn)
	}
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

// HandleKillApp terminates an active app session and its Slurm allocation.
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
		pid := session.cmd.Process.Pid

		// Close PTY and proxy first to unblock any pending reads.
		if session.ptmx != nil {
			_ = session.ptmx.Close()
		}
		if session.proxyLn != nil {
			_ = session.proxyLn.Close()
		}

		// Send SIGTERM to the entire process group so srun can scancel the Slurm
		// allocation before exiting. SIGKILL would kill srun without cleanup.
		pgid, err := syscall.Getpgid(pid)
		if err == nil {
			_ = syscall.Kill(-pgid, syscall.SIGTERM)
			// Give srun 5 s to cancel the allocation, then force-kill.
			go func() {
				time.Sleep(5 * time.Second)
				_ = syscall.Kill(-pgid, syscall.SIGKILL)
			}()
		} else {
			_ = session.cmd.Process.Kill()
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

