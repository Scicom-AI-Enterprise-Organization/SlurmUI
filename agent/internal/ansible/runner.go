package ansible

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"

	"github.com/scicom/aura/agent/internal/slurm"
)

// RunOpts configures an ansible-playbook invocation.
type RunOpts struct {
	// PlaybookDir is the base directory containing playbooks.
	PlaybookDir string

	// Playbook is the playbook filename (e.g., "activate_node.yml").
	Playbook string

	// VarsFile is the path to the JSON vars file (-e @file).
	VarsFile string

	// ExtraVars are additional key=value pairs passed via -e.
	ExtraVars map[string]string

	// Inventory is the inventory file or host pattern. Defaults to "localhost,".
	Inventory string
}

// Runner executes ansible-playbook as a subprocess.
type Runner struct {
	logger *slog.Logger
}

// NewRunner creates an Ansible runner.
func NewRunner(logger *slog.Logger) *Runner {
	return &Runner{logger: logger}
}

// Run executes an ansible-playbook command and streams stdout lines via streamFn.
func (r *Runner) Run(ctx context.Context, opts *RunOpts, streamFn slurm.StreamFunc) (*slurm.ExecResult, error) {
	playbookPath := filepath.Join(opts.PlaybookDir, opts.Playbook)
	args := r.buildArgs(opts, playbookPath)

	r.logger.Info("running ansible-playbook",
		"playbook", playbookPath,
		"vars_file", opts.VarsFile,
	)

	// Attach extra env vars for cleaner streaming output.
	// Use "default" callback — always available in ansible-core without extra collections.
	ansibleCtx := slurm.WithEnv(ctx, map[string]string{
		"ANSIBLE_STDOUT_CALLBACK":  "default",
		"ANSIBLE_FORCE_COLOR":      "0",
		"PYTHONUNBUFFERED":         "1",
		"ANSIBLE_HOST_KEY_CHECKING": "False",
	})

	result, err := slurm.RunCommandStreaming(ansibleCtx, streamFn, "ansible-playbook", args...)
	if err != nil {
		return nil, fmt.Errorf("ansible-playbook %s failed: %w", opts.Playbook, err)
	}

	if result.ExitCode != 0 {
		r.logger.Error("ansible-playbook failed",
			"playbook", opts.Playbook,
			"exit_code", result.ExitCode,
			"stderr", result.Stderr,
		)
	} else {
		r.logger.Info("ansible-playbook completed",
			"playbook", opts.Playbook,
		)
	}

	return result, nil
}

func (r *Runner) buildArgs(opts *RunOpts, playbookPath string) []string {
	var args []string

	// Inventory.
	inventory := opts.Inventory
	if inventory == "" {
		inventory = "localhost,"
	}
	args = append(args, "-i", inventory)

	// Vars file.
	if opts.VarsFile != "" {
		args = append(args, "-e", "@"+opts.VarsFile)
	}

	// Extra vars.
	for k, v := range opts.ExtraVars {
		args = append(args, "-e", fmt.Sprintf("%s=%s", k, v))
	}

	// Verbose diff output for better streaming visibility.
	args = append(args, "-v", "--diff")

	// The playbook path must be last.
	args = append(args, playbookPath)

	return args
}
