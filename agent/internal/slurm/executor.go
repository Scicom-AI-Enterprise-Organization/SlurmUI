package slurm

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
)

type envCtxKey struct{}

// WithEnv attaches extra environment variables to a context.
// They are merged on top of the current process environment when executing commands.
func WithEnv(ctx context.Context, env map[string]string) context.Context {
	return context.WithValue(ctx, envCtxKey{}, env)
}

// envFromCtx merges context env vars into os.Environ().
func envFromCtx(ctx context.Context) []string {
	base := os.Environ()
	extra, _ := ctx.Value(envCtxKey{}).(map[string]string)
	for k, v := range extra {
		base = append(base, k+"="+v)
	}
	return base
}

// ExecResult holds the output of a command execution.
type ExecResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
}

// RunCommand executes a command and returns the combined result.
func RunCommand(ctx context.Context, name string, args ...string) (*ExecResult, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = envFromCtx(ctx)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	result := &ExecResult{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
	}

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			return nil, fmt.Errorf("failed to run %s: %w", name, err)
		}
	}

	return result, nil
}

// StreamFunc is called for each line of stdout during streaming execution.
type StreamFunc func(line string, seq int)

// RunCommandStreaming executes a command and calls streamFn for each stdout line.
// Returns the full ExecResult after the command completes.
func RunCommandStreaming(ctx context.Context, streamFn StreamFunc, name string, args ...string) (*ExecResult, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = envFromCtx(ctx)

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start %s: %w", name, err)
	}

	// Stream stdout lines.
	var fullStdout bytes.Buffer
	scanner := bufio.NewScanner(stdoutPipe)
	seq := 0
	for scanner.Scan() {
		line := scanner.Text()
		seq++
		fullStdout.WriteString(line)
		fullStdout.WriteByte('\n')
		if streamFn != nil {
			streamFn(line, seq)
		}
	}

	// Drain any remaining data.
	io.Copy(&fullStdout, stdoutPipe)

	err = cmd.Wait()
	result := &ExecResult{
		Stdout: fullStdout.String(),
		Stderr: stderr.String(),
	}

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			return nil, fmt.Errorf("command %s failed: %w", name, err)
		}
	}

	return result, nil
}
