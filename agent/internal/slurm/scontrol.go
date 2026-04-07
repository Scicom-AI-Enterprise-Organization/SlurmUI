package slurm

import (
	"context"
	"fmt"
)

// ScontrolShowJob runs `scontrol show job <id> --json` and returns raw output.
func ScontrolShowJob(ctx context.Context, jobID string) (*ExecResult, error) {
	if jobID == "" {
		return nil, fmt.Errorf("job ID is required for scontrol show job")
	}
	return RunCommand(ctx, "scontrol", "show", "job", jobID, "--json")
}
