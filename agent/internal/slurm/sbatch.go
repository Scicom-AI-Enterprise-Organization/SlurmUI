package slurm

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// SbatchOpts configures an sbatch invocation.
type SbatchOpts struct {
	Script    string
	WorkDir   string
	JobName   string
	Partition string
	Nodes     int
	NTasks    int
	GPUs      string
	TimeLimit string
	ExtraArgs []string
	EnvVars   map[string]string
	Username  string // if set, runs as: sudo -u <Username> sbatch ...
}

// Sbatch runs `sbatch` with the given options and streams stdout.
// The script content is written to a temporary file.
func Sbatch(ctx context.Context, opts *SbatchOpts, streamFn StreamFunc) (*ExecResult, error) {
	// Write script to a temp file.
	tmpFile, err := os.CreateTemp("", "aura-sbatch-*.sh")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp script: %w", err)
	}
	defer os.Remove(tmpFile.Name())

	if _, err := tmpFile.WriteString(opts.Script); err != nil {
		tmpFile.Close()
		return nil, fmt.Errorf("failed to write script: %w", err)
	}
	tmpFile.Close()

	args := buildSbatchArgs(opts, tmpFile.Name())

	if opts.Username != "" {
		// Run as the provisioned Linux user so the job is owned by them in Slurm.
		sudoArgs := append([]string{"-u", opts.Username, "sbatch"}, args...)
		return RunCommandStreaming(ctx, streamFn, "sudo", sudoArgs...)
	}
	return RunCommandStreaming(ctx, streamFn, "sbatch", args...)
}

func buildSbatchArgs(opts *SbatchOpts, scriptPath string) []string {
	var args []string

	if opts.JobName != "" {
		args = append(args, "--job-name="+opts.JobName)
	}
	if opts.Partition != "" {
		args = append(args, "--partition="+opts.Partition)
	}
	if opts.WorkDir != "" {
		args = append(args, "--chdir="+opts.WorkDir)
	}
	if opts.Nodes > 0 {
		args = append(args, fmt.Sprintf("--nodes=%d", opts.Nodes))
	}
	if opts.NTasks > 0 {
		args = append(args, fmt.Sprintf("--ntasks=%d", opts.NTasks))
	}
	if opts.GPUs != "" {
		args = append(args, "--gpus="+opts.GPUs)
	}
	if opts.TimeLimit != "" {
		args = append(args, "--time="+opts.TimeLimit)
	}
	if len(opts.EnvVars) > 0 {
		var pairs []string
		for k, v := range opts.EnvVars {
			pairs = append(pairs, fmt.Sprintf("%s=%s", k, v))
		}
		args = append(args, "--export="+strings.Join(pairs, ","))
	}

	// Normalize extra args: resolve any path arguments.
	for _, arg := range opts.ExtraArgs {
		args = append(args, arg)
	}

	// Only apply default output/error paths if ExtraArgs hasn't already set --output.
	hasOutputArg := false
	for _, a := range opts.ExtraArgs {
		if strings.HasPrefix(a, "--output=") || strings.HasPrefix(a, "-o") {
			hasOutputArg = true
			break
		}
	}
	if opts.WorkDir != "" && !hasOutputArg {
		args = append(args,
			"--output="+filepath.Join(opts.WorkDir, "slurm-%j.out"),
			"--error="+filepath.Join(opts.WorkDir, "slurm-%j.err"),
		)
	}

	args = append(args, scriptPath)
	return args
}
