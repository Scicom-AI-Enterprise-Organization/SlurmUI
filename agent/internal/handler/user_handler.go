package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
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
	if err == nil && result.ExitCode != 0 {
		switch result.ExitCode {
		case 9:
			// User already exists — idempotent, continue
		case 4:
			// UID already used by a different user — this is a UID allocation conflict
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("useradd failed: UID %d is already assigned to a different user: %s", payload.UID, result.Stderr))
		default:
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("useradd failed (exit %d): %s", result.ExitCode, result.Stderr))
		}
	}

	// 3. Create NFS home directory
	emit(fmt.Sprintf("[aura] Creating NFS home dir: %s", payload.NfsHome))
	if err := os.MkdirAll(payload.NfsHome, 0700); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to create NFS home: %w", err))
	}
	if _, err := slurm.RunCommand(ctx, "chown",
		fmt.Sprintf("%d:%d", payload.UID, payload.GID),
		payload.NfsHome,
	); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("chown failed: %w", err))
	}

	// Seed skeleton files (.bashrc, .bash_profile) so the user has a working shell environment.
	writeSkeletonFile(ctx, filepath.Join(payload.NfsHome, ".bashrc"), fmt.Sprintf(
		"# .bashrc\nexport HOME=%s\nexport USER=%s\nexport PATH=$PATH:/usr/local/bin:/usr/bin:/bin\n[ -f /etc/bashrc ] && . /etc/bashrc\n",
		payload.NfsHome, payload.Username,
	), payload.UID, payload.GID)
	writeSkeletonFile(ctx, filepath.Join(payload.NfsHome, ".bash_profile"), fmt.Sprintf(
		"# .bash_profile\n[ -f ~/.bashrc ] && . ~/.bashrc\n",
	), payload.UID, payload.GID)
	emit("[aura] NFS home created with skeleton files")

	// 4a. Register user with Slurm accounting (tolerates absence of slurmdbd).
	emit("[aura] Registering user with Slurm accounting...")
	_, sacctAccErr := slurm.RunCommand(ctx, "sacctmgr", "-i", "add", "account",
		payload.Username, fmt.Sprintf("Description=Aura user %s", payload.Username), "Organization=Aura")
	_, sacctUserErr := slurm.RunCommand(ctx, "sacctmgr", "-i", "add", "user",
		payload.Username, "Account="+payload.Username)
	if sacctAccErr != nil || sacctUserErr != nil {
		emit("[aura] Note: Slurm accounting not available (slurmdbd not running) — skipped")
	} else {
		emit("[aura] Slurm accounting registered")
	}

	// 5. Replicate user to workers via Ansible (skip if no workers)
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

		// streamFn offsets Ansible's internal seq counter (s, starting at 0) by the current
		// outer seq so the combined stream is correctly ordered after the preceding emit() calls.
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
	} // end if workers

	emit(fmt.Sprintf("[aura] User %s provisioned successfully (uid=%d)", payload.Username, payload.UID))
	return h.publisher.SendResult(cmd.RequestID, map[string]interface{}{
		"username": payload.Username,
		"uid":      payload.UID,
		"gid":      payload.GID,
	})
}

// HandleDeprovisionUser removes a Linux user from the controller and all worker nodes,
// cleans up Slurm accounting records, and marks the provisioning as removed.
// The NFS home directory is preserved (not deleted) so data is not lost.
func (h *UserHandler) HandleDeprovisionUser(ctx context.Context, cmd *message.Command) error {
	var payload message.DeprovisionUserPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid deprovision_user payload: %w", err))
	}

	h.logger.Info("deprovisioning user",
		"request_id", cmd.RequestID,
		"username", payload.Username,
	)

	seq := 0
	emit := func(line string) {
		_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq)
		seq++
	}

	// 1. Remove Slurm accounting records (tolerate missing slurmdbd).
	emit("[aura] Removing Slurm accounting records...")
	_, _ = slurm.RunCommand(ctx, "sacctmgr", "-i", "delete", "user", payload.Username)
	_, _ = slurm.RunCommand(ctx, "sacctmgr", "-i", "delete", "account", payload.Username)
	emit("[aura] Slurm accounting cleanup done")

	// 2. Remove Linux user from controller.
	emit(fmt.Sprintf("[aura] Removing user %s from controller", payload.Username))
	result, err := slurm.RunCommand(ctx, "userdel", payload.Username)
	if err == nil && result.ExitCode != 0 && result.ExitCode != 6 {
		// exit 6 = user does not exist — idempotent
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("userdel failed (exit %d): %s", result.ExitCode, result.Stderr))
	}
	result, err = slurm.RunCommand(ctx, "groupdel", payload.Username)
	if err == nil && result.ExitCode != 0 && result.ExitCode != 6 {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("groupdel failed (exit %d): %s", result.ExitCode, result.Stderr))
	}
	emit("[aura] User removed from controller")

	// 3. Remove user from worker nodes via Ansible (skip if no workers).
	if len(payload.WorkerHosts) > 0 {
		emit("[aura] Removing user from worker nodes via Ansible...")

		inventory := h.buildWorkerInventory(payload.WorkerHosts)
		type deprovVars struct {
			Username string `json:"username"`
			UID      int    `json:"uid"`
			GID      int    `json:"gid"`
		}
		varsData, _ := json.Marshal(deprovVars{
			Username: payload.Username,
			UID:      payload.UID,
			GID:      payload.GID,
		})

		varsPath, err := writeTempConfig(json.RawMessage(varsData))
		if err != nil {
			return h.publisher.SendError(cmd.RequestID, err)
		}
		defer os.Remove(varsPath)

		invFile, err := os.CreateTemp("", "aura-deprov-inventory-*.ini")
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
			Playbook:    "user_deprovision.yml",
			VarsFile:    varsPath,
			Inventory:   invFile.Name(),
		}

		ansResult, err := h.runner.Run(ctx, opts, streamFn)
		if err != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("user_deprovision playbook failed: %w", err))
		}
		if ansResult.ExitCode != 0 {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("user_deprovision exited with code %d: %s", ansResult.ExitCode, ansResult.Stderr))
		}
		emit("[aura] User removed from all worker nodes")
	}

	emit(fmt.Sprintf("[aura] User %s deprovisioned successfully", payload.Username))
	return h.publisher.SendResult(cmd.RequestID, map[string]interface{}{
		"username": payload.Username,
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

// writeSkeletonFile writes content to path and sets ownership. Errors are non-fatal.
func writeSkeletonFile(ctx context.Context, path, content string, uid, gid int) {
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return
	}
	slurm.RunCommand(ctx, "chown", fmt.Sprintf("%d:%d", uid, gid), path)
}
