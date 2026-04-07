package slurm

import (
	"context"
	"fmt"
)

// Scancel cancels a Slurm job by ID.
func Scancel(ctx context.Context, jobID string) (*ExecResult, error) {
	if jobID == "" {
		return nil, fmt.Errorf("job ID is required for scancel")
	}
	return RunCommand(ctx, "scancel", jobID)
}
