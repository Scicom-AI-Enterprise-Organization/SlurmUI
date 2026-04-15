package handler

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/scicom/aura/agent/internal/message"
	agentNats "github.com/scicom/aura/agent/internal/nats"
	"github.com/scicom/aura/agent/internal/slurm"
)

// SlurmHandler processes Slurm-related commands.
type SlurmHandler struct {
	publisher *agentNats.Publisher
	logger    *slog.Logger
}

// NewSlurmHandler creates a SlurmHandler.
func NewSlurmHandler(publisher *agentNats.Publisher, logger *slog.Logger) *SlurmHandler {
	return &SlurmHandler{
		publisher: publisher,
		logger:    logger,
	}
}

// HandleSubmitJob processes a submit_job command.
func (h *SlurmHandler) HandleSubmitJob(ctx context.Context, cmd *message.Command) error {
	var payload message.SubmitJobPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid submit_job payload: %w", err))
	}

	h.logger.Info("submitting job", "request_id", cmd.RequestID, "job_name", payload.JobName)

	// Write output to a path visible to BOTH the controller (where the agent
	// runs) and the worker node (where the job executes).
	// If a shared NFS directory is provided, use it — the controller has that
	// path locally (it IS the NFS server) and workers see it via the NFS mount.
	// Fall back to /tmp only for single-node clusters (controller = worker).
	outputDir := "/tmp"
	if payload.OutputDir != "" {
		outputDir = strings.TrimRight(payload.OutputDir, "/") + "/aura-jobs"
		if err := os.MkdirAll(outputDir, 0o755); err != nil {
			h.logger.Warn("failed to create output dir, falling back to /tmp", "error", err)
			outputDir = "/tmp"
		}
	}
	outputFile := fmt.Sprintf("%s/aura-%s.out", outputDir, cmd.RequestID)

	opts := &slurm.SbatchOpts{
		Script:    payload.Script,
		WorkDir:   payload.WorkDir,
		JobName:   payload.JobName,
		Partition: payload.Partition,
		Nodes:     payload.Nodes,
		NTasks:    payload.NTasks,
		GPUs:      payload.GPUs,
		TimeLimit: payload.TimeLimit,
		ExtraArgs: append(payload.ExtraArgs, "--output="+outputFile),
		EnvVars:   payload.EnvVars,
	}

	streamFn := func(line string, seq int) {
		if err := h.publisher.SendStreamLine(cmd.RequestID, line, seq); err != nil {
			h.logger.Error("failed to stream sbatch line", "error", err)
		}
	}

	result, err := slurm.Sbatch(ctx, opts, streamFn)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("sbatch execution failed: %w", err))
	}

	if result.ExitCode != 0 {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("sbatch failed (exit %d): %s", result.ExitCode, result.Stderr))
	}

	// Parse slurm job ID from "Submitted batch job XXXXX"
	slurmJobID := parseSlurmJobID(result.Stdout)
	return h.publisher.SendResult(cmd.RequestID, map[string]interface{}{
		"slurm_job_id": slurmJobID,
		"output_file":  outputFile,
		"stdout":       result.Stdout,
	})
}

// parseSlurmJobID extracts the integer job ID from sbatch output like "Submitted batch job 12345".
func parseSlurmJobID(stdout string) int {
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Submitted batch job ") {
			idStr := strings.TrimPrefix(line, "Submitted batch job ")
			if id, err := strconv.Atoi(strings.TrimSpace(idStr)); err == nil {
				return id
			}
		}
	}
	return 0
}

// HandleCancelJob processes a cancel_job command.
func (h *SlurmHandler) HandleCancelJob(ctx context.Context, cmd *message.Command) error {
	var payload message.CancelJobPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid cancel_job payload: %w", err))
	}

	h.logger.Info("cancelling job", "request_id", cmd.RequestID, "job_id", payload.JobID)

	result, err := slurm.Scancel(ctx, payload.JobID)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("scancel failed: %w", err))
	}

	return h.publisher.SendResult(cmd.RequestID, result)
}

// HandleListJobs processes a list_jobs command.
func (h *SlurmHandler) HandleListJobs(ctx context.Context, cmd *message.Command) error {
	var payload message.ListJobsPayload
	// Payload is optional for list_jobs.
	if cmd.Payload != nil {
		json.Unmarshal(cmd.Payload, &payload)
	}

	h.logger.Info("listing jobs", "request_id", cmd.RequestID)

	result, err := slurm.Squeue(ctx, payload.User, payload.Partition)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("squeue failed: %w", err))
	}

	return h.publisher.SendResult(cmd.RequestID, result)
}

// HandleJobInfo processes a job_info command.
func (h *SlurmHandler) HandleJobInfo(ctx context.Context, cmd *message.Command) error {
	var payload message.JobInfoPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid job_info payload: %w", err))
	}

	h.logger.Info("getting job info", "request_id", cmd.RequestID, "job_id", payload.JobID)

	result, err := slurm.ScontrolShowJob(ctx, payload.JobID)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("scontrol show job failed: %w", err))
	}

	return h.publisher.SendResult(cmd.RequestID, result)
}

// HandleNodeStatus processes a node_status command.
func (h *SlurmHandler) HandleNodeStatus(ctx context.Context, cmd *message.Command) error {
	h.logger.Info("getting node status", "request_id", cmd.RequestID)

	result, err := slurm.Sinfo(ctx)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("sinfo failed: %w", err))
	}

	return h.publisher.SendResult(cmd.RequestID, result)
}

// HandleWatchJob tails the Slurm job output file and streams it line-by-line
// until the job completes, then sends a final result with the exit code.
func (h *SlurmHandler) HandleWatchJob(ctx context.Context, cmd *message.Command) error {
	var payload message.WatchJobPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid watch_job payload: %w", err))
	}

	h.logger.Info("watching job output", "request_id", cmd.RequestID, "slurm_job_id", payload.SlurmJobID)

	// Wait up to 60 s for Slurm to create the output file.
	deadline := time.Now().Add(60 * time.Second)
	for {
		if _, err := os.Stat(payload.OutputFile); err == nil {
			break
		}
		if time.Now().After(deadline) {
			return h.publisher.SendError(cmd.RequestID,
				fmt.Errorf("output file never appeared: %s", payload.OutputFile))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}

	f, err := os.Open(payload.OutputFile)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to open output file: %w", err))
	}
	defer f.Close()

	seq := 0
	var outputLines []string
	reader := bufio.NewReader(f)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			clean := strings.TrimRight(line, "\r\n")
			outputLines = append(outputLines, clean)
			seq++
			if pubErr := h.publisher.SendStreamLine(cmd.RequestID, clean, seq); pubErr != nil {
				h.logger.Error("failed to stream job output line", "error", pubErr)
			}
		}
		if err == io.EOF {
			running, _ := slurmJobRunning(ctx, payload.SlurmJobID)
			if !running {
				// Drain any remaining lines written after the last read.
				for {
					line, err2 := reader.ReadString('\n')
					if len(line) > 0 {
						clean := strings.TrimRight(line, "\r\n")
						outputLines = append(outputLines, clean)
						seq++
						h.publisher.SendStreamLine(cmd.RequestID, clean, seq)
					}
					if err2 != nil {
						break
					}
				}
				break
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(2 * time.Second):
			}
			continue
		}
		if err != nil {
			break
		}
	}

	exitCode := slurmJobExitCode(ctx, payload.SlurmJobID)
	return h.publisher.SendResult(cmd.RequestID, map[string]interface{}{
		"exit_code": exitCode,
		"success":   exitCode == 0,
		"output":    strings.Join(outputLines, "\n"),
	})
}

// slurmJobRunning returns true if the job is still in squeue.
func slurmJobRunning(ctx context.Context, slurmJobID int) (bool, error) {
	out, err := exec.CommandContext(ctx, "squeue", "-j", strconv.Itoa(slurmJobID), "-h").Output()
	if err != nil {
		return false, nil // not found → completed
	}
	return strings.TrimSpace(string(out)) != "", nil
}

// slurmJobExitCode returns the job's exit code after completion.
// Tries scontrol first (works without accounting), then sacct as fallback.
// Returns 0 if neither can determine the exit code (job completed normally).
func slurmJobExitCode(ctx context.Context, slurmJobID int) int {
	// scontrol show job works for recently-completed jobs without accounting.
	out, err := exec.CommandContext(ctx, "scontrol", "show", "job", strconv.Itoa(slurmJobID)).Output()
	if err == nil {
		for _, field := range strings.Fields(string(out)) {
			if strings.HasPrefix(field, "ExitCode=") {
				parts := strings.SplitN(strings.TrimPrefix(field, "ExitCode="), ":", 2)
				code, _ := strconv.Atoi(parts[0])
				return code
			}
		}
	}
	// sacct fallback (requires AccountingStorageType != none)
	out, err = exec.CommandContext(ctx, "sacct",
		"-j", strconv.Itoa(slurmJobID),
		"--format=ExitCode", "--noheader", "--parsable2",
	).Output()
	if err == nil {
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			parts := strings.SplitN(strings.TrimSpace(line), ":", 2)
			if len(parts) >= 1 && parts[0] != "" {
				code, _ := strconv.Atoi(parts[0])
				return code
			}
		}
	}
	// Cannot determine exit code — assume success if job left queue normally.
	return 0
}
