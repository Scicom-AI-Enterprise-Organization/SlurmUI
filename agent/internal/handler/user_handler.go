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
	"github.com/scicom/aura/agent/internal/slurm"
)

// UserHandler processes user provisioning commands.
type UserHandler struct {
	publisher   *agentNats.Publisher
	runner      *ansible.Runner
	playbookDir string
	logger      *slog.Logger
}

// NewUserHandler creates a UserHandler.
func NewUserHandler(publisher *agentNats.Publisher, runner *ansible.Runner, playbookDir string, logger *slog.Logger) *UserHandler {
	return &UserHandler{
		publisher:   publisher,
		runner:      runner,
		playbookDir: playbookDir,
		logger:      logger,
	}
}

// HandleProvisionUser creates a Linux user on master (with NFS home) and replicates to workers.
func (h *UserHandler) HandleProvisionUser(ctx context.Context, cmd *message.Command) error {
	var payload message.ProvisionUserPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid provision_user payload: %w", err))
	}

	h.logger.Info("provisioning user",
		"request_id", cmd.RequestID,
		"username", payload.Username,
		"uid", payload.UID,
	)

	seq := 0
	emit := func(line string) {
		_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq)
		seq++
	}

	// 1. Create group on master
	emit(fmt.Sprintf("[aura] Creating group %s (gid=%d) on master", payload.Username, payload.GID))
	result, err := slurm.RunCommand(ctx, "groupadd", "-g", fmt.Sprintf("%d", payload.GID), payload.Username)
	if err == nil && result.ExitCode != 0 && result.ExitCode != 9 {
		// exit code 9 = group already exists, which is fine
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("groupadd failed: %s", result.Stderr))
	}

	// 2. Create user on master
	emit(fmt.Sprintf("[aura] Creating user %s (uid=%d) on master", payload.Username, payload.UID))
	result, err = slurm.RunCommand(ctx,
		"useradd",
		"-u", fmt.Sprintf("%d", payload.UID),
		"-g", fmt.Sprintf("%d", payload.GID),
		"-d", payload.NfsHome,
		"-M", // don't create home locally
		payload.Username,
	)
	if err == nil && result.ExitCode != 0 && result.ExitCode != 9 {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("useradd failed: %s", result.Stderr))
	}

	// 3. Create NFS home directory
	emit(fmt.Sprintf("[aura] Creating NFS home dir: %s", payload.NfsHome))
	if err := os.MkdirAll(payload.NfsHome, 0755); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to create NFS home: %w", err))
	}
	if _, err := slurm.RunCommand(ctx, "chown",
		fmt.Sprintf("%d:%d", payload.UID, payload.GID),
		payload.NfsHome,
	); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("chown failed: %w", err))
	}
	emit("[aura] NFS home created")

	// 4. Replicate user to workers via Ansible (skip if no workers)
	if len(payload.WorkerHosts) > 0 {
		emit("[aura] Replicating user to worker nodes via Ansible...")

		inventory := h.buildWorkerInventory(payload.WorkerHosts)
		type userVars struct {
			Username string `json:"username"`
			UID      int    `json:"uid"`
			GID      int    `json:"gid"`
		}
		varsData, _ := json.Marshal(userVars{
			Username: payload.Username,
			UID:      payload.UID,
			GID:      payload.GID,
		})

		varsPath, err := writeTempConfig(json.RawMessage(varsData))
		if err != nil {
			return h.publisher.SendError(cmd.RequestID, err)
		}
		defer os.Remove(varsPath)

		invFile, err := os.CreateTemp("", "aura-worker-inventory-*.ini")
		if err != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to create inventory: %w", err))
		}
		invFile.WriteString(inventory)
		invFile.Close()
		defer os.Remove(invFile.Name())

		streamFn := func(line string, s int) {
			_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq+s)
		}

		opts := &ansible.RunOpts{
			PlaybookDir: h.playbookDir,
			Playbook:    "user_provision.yml",
			VarsFile:    varsPath,
			Inventory:   invFile.Name(),
		}

		ansResult, err := h.runner.Run(ctx, opts, streamFn)
		if err != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("user_provision playbook failed: %w", err))
		}
		if ansResult.ExitCode != 0 {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("user_provision exited with code %d: %s", ansResult.ExitCode, ansResult.Stderr))
		}
		emit("[aura] User replicated to all workers")
	}

	emit(fmt.Sprintf("[aura] User %s provisioned successfully (uid=%d)", payload.Username, payload.UID))
	return h.publisher.SendResult(cmd.RequestID, map[string]interface{}{
		"username": payload.Username,
		"uid":      payload.UID,
		"gid":      payload.GID,
	})
}

func (h *UserHandler) buildWorkerInventory(hosts []message.WorkerHost) string {
	sshKeyArg := ""
	if _, err := os.Stat("/root/.ssh/aura_cluster_key"); err == nil {
		sshKeyArg = " ansible_ssh_private_key_file=/root/.ssh/aura_cluster_key"
	}
	var sb strings.Builder
	sb.WriteString("[workers]\n")
	for _, host := range hosts {
		sb.WriteString(fmt.Sprintf("%s ansible_host=%s ansible_user=root ansible_python_interpreter=/usr/bin/python3%s\n",
			host.Hostname, host.IP, sshKeyArg))
	}
	return sb.String()
}
