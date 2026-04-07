package slurm

import (
	"context"
	"encoding/json"
	"fmt"
)

// SqueueResult is the parsed JSON output from `squeue --json`.
type SqueueResult struct {
	Jobs json.RawMessage `json:"jobs"`
}

// Squeue runs `squeue --json` and returns the raw result.
func Squeue(ctx context.Context, user, partition string) (*ExecResult, error) {
	args := []string{"--json"}
	if user != "" {
		args = append(args, "--user="+user)
	}
	if partition != "" {
		args = append(args, "--partition="+partition)
	}
	return RunCommand(ctx, "squeue", args...)
}

// SqueueParsed runs squeue and parses the JSON output.
func SqueueParsed(ctx context.Context, user, partition string) (*SqueueResult, error) {
	result, err := Squeue(ctx, user, partition)
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 {
		return nil, fmt.Errorf("squeue failed (exit %d): %s", result.ExitCode, result.Stderr)
	}

	var parsed SqueueResult
	if err := json.Unmarshal([]byte(result.Stdout), &parsed); err != nil {
		return nil, fmt.Errorf("failed to parse squeue JSON: %w", err)
	}
	return &parsed, nil
}
