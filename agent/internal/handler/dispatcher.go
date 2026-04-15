package handler

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/scicom/aura/agent/internal/message"
	agentNats "github.com/scicom/aura/agent/internal/nats"
)

// Dispatcher routes incoming commands to the appropriate handler.
type Dispatcher struct {
	slurm     *SlurmHandler
	deploy    *DeployHandler
	setup     *SetupHandler
	user      *UserHandler
	publisher *agentNats.Publisher
	logger    *slog.Logger
}

// NewDispatcher creates a Dispatcher with all handlers.
func NewDispatcher(
	slurmHandler *SlurmHandler,
	deployHandler *DeployHandler,
	setupHandler *SetupHandler,
	userHandler *UserHandler,
	publisher *agentNats.Publisher,
	logger *slog.Logger,
) *Dispatcher {
	return &Dispatcher{
		slurm:     slurmHandler,
		deploy:    deployHandler,
		setup:     setupHandler,
		user:      userHandler,
		publisher: publisher,
		logger:    logger,
	}
}

// Dispatch routes a command to the correct handler based on command type.
func (d *Dispatcher) Dispatch(ctx context.Context, cmd *message.Command) error {
	d.logger.Info("dispatching command",
		"request_id", cmd.RequestID,
		"type", cmd.Type,
	)

	switch cmd.Type {
	// Slurm commands
	case message.CmdSubmitJob:
		return d.slurm.HandleSubmitJob(ctx, cmd)
	case message.CmdCancelJob:
		return d.slurm.HandleCancelJob(ctx, cmd)
	case message.CmdListJobs:
		return d.slurm.HandleListJobs(ctx, cmd)
	case message.CmdJobInfo:
		return d.slurm.HandleJobInfo(ctx, cmd)
	case message.CmdNodeStatus:
		return d.slurm.HandleNodeStatus(ctx, cmd)
	case message.CmdWatchJob:
		return d.slurm.HandleWatchJob(ctx, cmd)

	// Deploy commands
	case message.CmdActivateNode:
		return d.deploy.HandleActivateNode(ctx, cmd)
	case message.CmdAddNode:
		return d.deploy.HandleAddNode(ctx, cmd)
	case message.CmdPropagateConfig:
		return d.deploy.HandlePropagateConfig(ctx, cmd)
	case message.CmdCreateHomedir:
		return d.deploy.HandleCreateHomedir(ctx, cmd)

	// Setup commands
	case message.CmdTestNfs:
		return d.setup.HandleTestNfs(ctx, cmd)
	case message.CmdSetupNodes:
		return d.setup.HandleSetupNodes(ctx, cmd)
	case message.CmdSetupPartitions:
		return d.setup.HandleSetupPartitions(ctx, cmd)
	case message.CmdClusterHealth:
		return d.setup.HandleClusterHealth(ctx, cmd)
	case message.CmdTeardown:
		return d.setup.HandleTeardown(ctx, cmd)

	// User provisioning commands
	case message.CmdProvisionUser:
		return d.user.HandleProvisionUser(ctx, cmd)
	case message.CmdDeprovisionUser:
		return d.user.HandleDeprovisionUser(ctx, cmd)

	default:
		err := fmt.Errorf("unknown command type: %s", cmd.Type)
		d.logger.Warn("unknown command type",
			"request_id", cmd.RequestID,
			"type", cmd.Type,
		)
		return d.publisher.SendError(cmd.RequestID, err)
	}
}
