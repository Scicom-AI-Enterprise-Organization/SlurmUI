package slurm

import (
	"context"
	"strings"
	"testing"
)

func TestRunCommand_Echo(t *testing.T) {
	result, err := RunCommand(context.Background(), "echo", "hello world")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ExitCode != 0 {
		t.Errorf("expected exit code 0, got %d", result.ExitCode)
	}
	if strings.TrimSpace(result.Stdout) != "hello world" {
		t.Errorf("expected 'hello world', got %q", result.Stdout)
	}
}

func TestRunCommand_NonZeroExit(t *testing.T) {
	result, err := RunCommand(context.Background(), "sh", "-c", "exit 42")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ExitCode != 42 {
		t.Errorf("expected exit code 42, got %d", result.ExitCode)
	}
}

func TestRunCommand_Stderr(t *testing.T) {
	result, err := RunCommand(context.Background(), "sh", "-c", "echo error >&2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result.Stderr, "error") {
		t.Errorf("expected stderr to contain 'error', got %q", result.Stderr)
	}
}

func TestRunCommand_ContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	_, err := RunCommand(ctx, "sleep", "10")
	if err == nil {
		t.Error("expected error from cancelled context")
	}
}

func TestRunCommandStreaming(t *testing.T) {
	var lines []string
	streamFn := func(line string, seq int) {
		lines = append(lines, line)
	}

	result, err := RunCommandStreaming(context.Background(), streamFn, "sh", "-c", "echo line1; echo line2; echo line3")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ExitCode != 0 {
		t.Errorf("expected exit code 0, got %d", result.ExitCode)
	}
	if len(lines) != 3 {
		t.Errorf("expected 3 lines streamed, got %d: %v", len(lines), lines)
	}
	if lines[0] != "line1" || lines[1] != "line2" || lines[2] != "line3" {
		t.Errorf("unexpected lines: %v", lines)
	}
}
