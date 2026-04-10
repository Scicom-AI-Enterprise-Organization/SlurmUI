package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"

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

	opts := &slurm.SbatchOpts{
		Script:    payload.Script,
		WorkDir:   payload.WorkDir,
		JobName:   payload.JobName,
		Partition: payload.Partition,
		Nodes:     payload.Nodes,
		NTasks:    payload.NTasks,
		GPUs:      payload.GPUs,
		TimeLimit: payload.TimeLimit,
		ExtraArgs: payload.ExtraArgs,
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
