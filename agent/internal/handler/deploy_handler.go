package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"

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

// HandleAddNode runs the add_node.yml playbook, then replicates existing users
// and previously installed packages to the new node.
func (h *DeployHandler) HandleAddNode(ctx context.Context, cmd *message.Command) error {
	var payload message.AddNodePayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid add_node payload: %w", err))
	}

	h.logger.Info("adding node",
		"request_id", cmd.RequestID,
		"target_node", payload.TargetNode,
		"existing_users", len(payload.ExistingUsers),
		"extra_packages", len(payload.ExtraPackages),
	)

	seq := 0
	emit := func(line string) {
		_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq)
		seq++
	}
	streamFn := func(line string, s int) {
		_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq+s)
	}

	// --- Step 1: run add_node.yml ---
	varsFile, cleanup, err := resolveVarsFile(payload.VarsFile, payload.Config)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, err)
	}
	defer cleanup()

	addOpts := &ansible.RunOpts{
		PlaybookDir: h.playbookDir,
		Playbook:    "add_node.yml",
		VarsFile:    varsFile,
		ExtraVars:   map[string]string{"target_node": payload.TargetNode},
	}
	addResult, err := h.runner.Run(ctx, addOpts, streamFn)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("add_node playbook failed: %w", err))
	}
	if addResult.ExitCode != 0 {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("add_node exited with code %d: %s", addResult.ExitCode, addResult.Stderr))
	}

	// Build a single-host inventory pointing at the new node.
	sshKeyArg := ""
	if _, statErr := os.Stat("/root/.ssh/aura_cluster_key"); statErr == nil {
		sshKeyArg = " ansible_ssh_private_key_file=/root/.ssh/aura_cluster_key"
	}
	nodeInventory := fmt.Sprintf(
		"[workers]\n%s ansible_host=%s ansible_user=root ansible_python_interpreter=/usr/bin/python3%s\n",
		payload.TargetNode, payload.TargetIP, sshKeyArg,
	)

	// --- Step 2: replicate existing users ---
	if len(payload.ExistingUsers) > 0 {
		emit(fmt.Sprintf("[aura] Replicating %d existing user(s) to %s...", len(payload.ExistingUsers), payload.TargetNode))

		invFile, invErr := os.CreateTemp("", "aura-addnode-inv-*.ini")
		if invErr != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to create inventory: %w", invErr))
		}
		invFile.WriteString(nodeInventory)
		invFile.Close()
		defer os.Remove(invFile.Name())

		for _, u := range payload.ExistingUsers {
			emit(fmt.Sprintf("[aura] Provisioning user %s (uid=%d) on %s", u.Username, u.UID, payload.TargetNode))
			type userVars struct {
				Username string `json:"username"`
				UID      int    `json:"uid"`
				GID      int    `json:"gid"`
			}
			varsData, _ := json.Marshal(userVars{Username: u.Username, UID: u.UID, GID: u.GID})
			uVarsPath, uErr := writeTempConfig(json.RawMessage(varsData))
			if uErr != nil {
				emit(fmt.Sprintf("[aura] Warning: could not write vars for user %s: %v", u.Username, uErr))
				continue
			}
			uResult, uRunErr := h.runner.Run(ctx, &ansible.RunOpts{
				PlaybookDir: h.playbookDir,
				Playbook:    "user_provision.yml",
				VarsFile:    uVarsPath,
				Inventory:   invFile.Name(),
			}, streamFn)
			os.Remove(uVarsPath)
			if uRunErr != nil || (uResult != nil && uResult.ExitCode != 0) {
				emit(fmt.Sprintf("[aura] Warning: failed to replicate user %s — continuing", u.Username))
			}
		}
		emit("[aura] User replication done")
	}

	// --- Step 3: install previously installed packages ---
	if len(payload.ExtraPackages) > 0 {
		emit(fmt.Sprintf("[aura] Installing %d extra package(s) on %s: %v", len(payload.ExtraPackages), payload.TargetNode, payload.ExtraPackages))

		pkgInvFile, pkgInvErr := os.CreateTemp("", "aura-addnode-pkg-inv-*.ini")
		if pkgInvErr != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to create package inventory: %w", pkgInvErr))
		}
		// install_packages.yml targets [all]
		pkgInvFile.WriteString(strings.Replace(nodeInventory, "[workers]", "[all]", 1))
		pkgInvFile.Close()
		defer os.Remove(pkgInvFile.Name())

		pkgVarsData, _ := json.Marshal(map[string]interface{}{"packages": payload.ExtraPackages})
		pkgVarsPath, pkgVarsErr := writeTempConfig(json.RawMessage(pkgVarsData))
		if pkgVarsErr != nil {
			emit(fmt.Sprintf("[aura] Warning: could not write package vars: %v", pkgVarsErr))
		} else {
			defer os.Remove(pkgVarsPath)
			pkgResult, pkgErr := h.runner.Run(ctx, &ansible.RunOpts{
				PlaybookDir: h.playbookDir,
				Playbook:    "install_packages.yml",
				VarsFile:    pkgVarsPath,
				Inventory:   pkgInvFile.Name(),
			}, streamFn)
			if pkgErr != nil || (pkgResult != nil && pkgResult.ExitCode != 0) {
				emit("[aura] Warning: package installation failed — node is functional but may be missing packages")
			} else {
				emit("[aura] Extra packages installed")
			}
		}
	}

	emit(fmt.Sprintf("[aura] Node %s fully onboarded", payload.TargetNode))
	return h.publisher.SendResult(cmd.RequestID, addResult)
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
