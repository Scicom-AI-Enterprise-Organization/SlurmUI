package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"

	"github.com/scicom/aura/agent/internal/ansible"
	"github.com/scicom/aura/agent/internal/message"
	agentNats "github.com/scicom/aura/agent/internal/nats"
)

// DeployHandler processes Ansible deploy commands.
type DeployHandler struct {
	publisher   *agentNats.Publisher
	runner      *ansible.Runner
	playbookDir string
	logger      *slog.Logger
}

// NewDeployHandler creates a DeployHandler.
func NewDeployHandler(publisher *agentNats.Publisher, runner *ansible.Runner, playbookDir string, logger *slog.Logger) *DeployHandler {
	return &DeployHandler{
		publisher:   publisher,
		runner:      runner,
		playbookDir: playbookDir,
		logger:      logger,
	}
}

// writeTempConfig writes inline config JSON to a temp file and returns the path.
// The caller is responsible for removing the file when done.
func writeTempConfig(config json.RawMessage) (string, error) {
	f, err := os.CreateTemp("", "aura-cluster-config-*.json")
	if err != nil {
		return "", fmt.Errorf("failed to create temp config file: %w", err)
	}
	if _, err := f.Write(config); err != nil {
		f.Close()
		os.Remove(f.Name())
		return "", fmt.Errorf("failed to write temp config: %w", err)
	}
	f.Close()
	return f.Name(), nil
}

// resolveVarsFile returns the vars file path, writing a temp file if inline config is provided.
// Returns the path and a cleanup function (may be a no-op).
func resolveVarsFile(varsFile string, config json.RawMessage) (string, func(), error) {
	if varsFile != "" {
		return varsFile, func() {}, nil
	}
	if len(config) > 0 {
		path, err := writeTempConfig(config)
		if err != nil {
			return "", func() {}, err
		}
		return path, func() { os.Remove(path) }, nil
	}
	return "", func() {}, nil
}

// HandleActivateNode runs the activate_node.yml playbook.
func (h *DeployHandler) HandleActivateNode(ctx context.Context, cmd *message.Command) error {
	var payload message.ActivateNodePayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid activate_node payload: %w", err))
	}

	h.logger.Info("activating node",
		"request_id", cmd.RequestID,
		"target_node", payload.TargetNode,
	)

	varsFile, cleanup, err := resolveVarsFile(payload.VarsFile, payload.Config)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, err)
	}
	defer cleanup()

	opts := &ansible.RunOpts{
		PlaybookDir: h.playbookDir,
		Playbook:    "activate_node.yml",
		VarsFile:    varsFile,
		ExtraVars: map[string]string{
			"target_node": payload.TargetNode,
		},
	}

	return h.runPlaybook(ctx, cmd.RequestID, opts)
}

// HandleAddNode runs the add_node.yml playbook.
func (h *DeployHandler) HandleAddNode(ctx context.Context, cmd *message.Command) error {
	var payload message.AddNodePayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid add_node payload: %w", err))
	}

	h.logger.Info("adding node",
		"request_id", cmd.RequestID,
		"target_node", payload.TargetNode,
	)

	varsFile, cleanup, err := resolveVarsFile(payload.VarsFile, payload.Config)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, err)
	}
	defer cleanup()

	opts := &ansible.RunOpts{
		PlaybookDir: h.playbookDir,
		Playbook:    "add_node.yml",
		VarsFile:    varsFile,
		ExtraVars: map[string]string{
			"target_node": payload.TargetNode,
		},
	}

	return h.runPlaybook(ctx, cmd.RequestID, opts)
}

// HandlePropagateConfig runs the propagate_config.yml playbook.
func (h *DeployHandler) HandlePropagateConfig(ctx context.Context, cmd *message.Command) error {
	var payload message.PropagateConfigPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid propagate_config payload: %w", err))
	}

	h.logger.Info("propagating config", "request_id", cmd.RequestID)

	varsFile, cleanup, err := resolveVarsFile(payload.VarsFile, payload.Config)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, err)
	}
	defer cleanup()

	opts := &ansible.RunOpts{
		PlaybookDir: h.playbookDir,
		Playbook:    "propagate_config.yml",
		VarsFile:    varsFile,
	}

	return h.runPlaybook(ctx, cmd.RequestID, opts)
}

// HandleCreateHomedir runs the user_homedir.yml playbook.
func (h *DeployHandler) HandleCreateHomedir(ctx context.Context, cmd *message.Command) error {
	var payload message.CreateHomedirPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid create_homedir payload: %w", err))
	}

	h.logger.Info("creating home directory",
		"request_id", cmd.RequestID,
		"username", payload.Username,
	)

	varsFile, cleanup, err := resolveVarsFile(payload.VarsFile, payload.Config)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, err)
	}
	defer cleanup()

	opts := &ansible.RunOpts{
		PlaybookDir: h.playbookDir,
		Playbook:    "user_homedir.yml",
		VarsFile:    varsFile,
		ExtraVars: map[string]string{
			"username": payload.Username,
			"user_uid": fmt.Sprintf("%d", payload.UserUID),
			"user_gid": fmt.Sprintf("%d", payload.UserGID),
		},
	}

	return h.runPlaybook(ctx, cmd.RequestID, opts)
}

// runPlaybook is a helper that runs a playbook, streams output, and sends the result.
func (h *DeployHandler) runPlaybook(ctx context.Context, requestID string, opts *ansible.RunOpts) error {
	streamFn := func(line string, seq int) {
		if err := h.publisher.SendStreamLine(requestID, line, seq); err != nil {
			h.logger.Error("failed to stream ansible line", "error", err)
		}
	}

	result, err := h.runner.Run(ctx, opts, streamFn)
	if err != nil {
		return h.publisher.SendError(requestID, fmt.Errorf("ansible-playbook failed: %w", err))
	}

	if result.ExitCode != 0 {
		return h.publisher.SendError(requestID, fmt.Errorf("ansible-playbook exited with code %d: %s", result.ExitCode, result.Stderr))
	}

	return h.publisher.SendResult(requestID, result)
}
