package slurm

import (
	"context"
	"encoding/json"
	"fmt"
)

// SinfoResult is the parsed JSON output from `sinfo --json`.
type SinfoResult struct {
	Nodes json.RawMessage `json:"nodes"`
}

// Sinfo runs `sinfo --json` and returns the raw result.
func Sinfo(ctx context.Context) (*ExecResult, error) {
	return RunCommand(ctx, "sinfo", "--json")
}

// SinfoParsed runs sinfo and parses the JSON output.
func SinfoParsed(ctx context.Context) (*SinfoResult, error) {
	result, err := Sinfo(ctx)
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 {
		return nil, fmt.Errorf("sinfo failed (exit %d): %s", result.ExitCode, result.Stderr)
	}

	var parsed SinfoResult
	if err := json.Unmarshal([]byte(result.Stdout), &parsed); err != nil {
		return nil, fmt.Errorf("failed to parse sinfo JSON: %w", err)
	}
	return &parsed, nil
}
