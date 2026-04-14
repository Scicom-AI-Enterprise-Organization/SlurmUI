package handler

import (
	"context"
	"encoding/base64"
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

// SetupHandler processes Phase 2 cluster setup commands.
type SetupHandler struct {
	publisher   *agentNats.Publisher
	runner      *ansible.Runner
	playbookDir string
	logger      *slog.Logger
}

// NewSetupHandler creates a SetupHandler.
func NewSetupHandler(publisher *agentNats.Publisher, runner *ansible.Runner, playbookDir string, logger *slog.Logger) *SetupHandler {
	return &SetupHandler{
		publisher:   publisher,
		runner:      runner,
		playbookDir: playbookDir,
		logger:      logger,
	}
}

// HandleTestNfs validates NFS shares are reachable and mountable.
func (h *SetupHandler) HandleTestNfs(ctx context.Context, cmd *message.Command) error {
	var payload message.TestNfsPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid test_nfs payload: %w", err))
	}

	h.logger.Info("testing NFS connectivity", "request_id", cmd.RequestID)

	seq := 0
	emit := func(line string) {
		_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq)
		seq++
	}

	// Use nc (netcat) to probe TCP port 2049 — avoids showmount/rpcbind hangs.
	for _, check := range []struct{ label, server, path string }{
		{"mgmt", payload.MgmtNfsServer, payload.MgmtNfsPath},
		{"data", payload.DataNfsServer, payload.DataNfsPath},
	} {
		emit(fmt.Sprintf("[aura] Testing %s NFS: %s:%s", check.label, check.server, check.path))
		result, err := slurm.RunCommand(ctx, "nc", "-zw5", check.server, "2049")
		if err != nil || result.ExitCode != 0 {
			return h.publisher.SendError(cmd.RequestID,
				fmt.Errorf("%s NFS server %s is not reachable on port 2049: %s", check.label, check.server, result.Stderr))
		}
		emit(fmt.Sprintf("[aura] ✓ %s NFS server %s:2049 reachable", check.label, check.server))
	}
	emit("[aura] NFS connectivity OK")

	return h.publisher.SendResult(cmd.RequestID, map[string]string{"status": "ok"})
}

// HandleSetupNodes writes /etc/hosts, saves SSH key, probes node reachability,
// and runs setup_nodes.yml on reachable nodes only.
func (h *SetupHandler) HandleSetupNodes(ctx context.Context, cmd *message.Command) error {
	var payload message.SetupNodesPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid setup_nodes payload: %w", err))
	}

	h.logger.Info("setting up nodes", "request_id", cmd.RequestID, "node_count", len(payload.Nodes))

	// Save SSH private key if provided.
	sshKeyPath := ""
	if payload.SSHPrivateKey != "" {
		keyBytes, err := base64.StdEncoding.DecodeString(payload.SSHPrivateKey)
		if err != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to decode SSH key: %w", err))
		}
		sshDir := "/root/.ssh"
		if err := os.MkdirAll(sshDir, 0700); err != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to create .ssh dir: %w", err))
		}
		sshKeyPath = filepath.Join(sshDir, "aura_cluster_key")
		if err := os.WriteFile(sshKeyPath, keyBytes, 0600); err != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to write SSH key: %w", err))
		}
		_ = h.publisher.SendStreamLine(cmd.RequestID, "[aura] SSH key saved to "+sshKeyPath, 0)
	}

	// Probe reachability for worker nodes (skip controller — it's localhost).
	seq := 1
	emit := func(line string) {
		_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq)
		seq++
	}

	var reachable []message.NodeEntry
	for _, n := range payload.Nodes {
		if n.Hostname == payload.ControllerHostname {
			reachable = append(reachable, n)
			continue
		}
		if h.probeNode(ctx, n.IP, sshKeyPath, emit) {
			reachable = append(reachable, n)
		}
	}

	if len(reachable) == 0 {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf(
			"no nodes were reachable via SSH — check that the SSH public key is authorized on each node"))
	}
	if len(reachable) < len(payload.Nodes) {
		emit(fmt.Sprintf("[aura] %d/%d nodes reachable — proceeding with reachable nodes only",
			len(reachable), len(payload.Nodes)))
	} else {
		emit(fmt.Sprintf("[aura] All %d nodes reachable", len(reachable)))
	}

	// Replace payload.Nodes with only the reachable set for Ansible.
	payload.Nodes = reachable

	// Write vars file for Ansible.
	type nodeVars struct {
		ControllerHostname string              `json:"controller_hostname"`
		ControllerIsWorker bool                `json:"controller_is_worker"`
		Nodes              []message.NodeEntry `json:"nodes"`
		MgmtNfsServer      string              `json:"mgmt_nfs_server"`
		MgmtNfsPath        string              `json:"mgmt_nfs_path"`
		DataNfsServer      string              `json:"data_nfs_server"`
		DataNfsPath        string              `json:"data_nfs_path"`
	}
	vars := nodeVars{
		ControllerHostname: payload.ControllerHostname,
		ControllerIsWorker: payload.ControllerIsWorker,
		Nodes:              payload.Nodes,
		MgmtNfsServer:      payload.MgmtNfsServer,
		MgmtNfsPath:        payload.MgmtNfsPath,
		DataNfsServer:      payload.DataNfsServer,
		DataNfsPath:        payload.DataNfsPath,
	}
	varsData, err := json.Marshal(vars)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to marshal vars: %w", err))
	}

	varsPath, err := writeTempConfig(json.RawMessage(varsData))
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, err)
	}
	defer os.Remove(varsPath)

	// Build inventory with controller + workers.
	inventory := h.buildInventory(payload)

	invFile, err := os.CreateTemp("", "aura-inventory-*.ini")
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to create inventory file: %w", err))
	}
	invFile.WriteString(inventory)
	invFile.Close()
	defer os.Remove(invFile.Name())

	streamFn := func(line string, seq int) {
		_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq)
	}

	opts := &ansible.RunOpts{
		PlaybookDir: h.playbookDir,
		Playbook:    "setup_nodes.yml",
		VarsFile:    varsPath,
		Inventory:   invFile.Name(),
	}

	result, err := h.runner.Run(ctx, opts, streamFn)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("setup_nodes playbook failed: %w", err))
	}
	if result.ExitCode != 0 {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("setup_nodes exited with code %d: %s", result.ExitCode, result.Stderr))
	}

	return h.publisher.SendResult(cmd.RequestID, result)
}

// HandleSetupPartitions runs setup_partitions.yml on localhost.
func (h *SetupHandler) HandleSetupPartitions(ctx context.Context, cmd *message.Command) error {
	var payload message.SetupPartitionsPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid setup_partitions payload: %w", err))
	}

	h.logger.Info("setting up partitions", "request_id", cmd.RequestID, "count", len(payload.Partitions))

	type partVars struct {
		Partitions []message.PartitionDef `json:"partitions"`
	}
	varsData, err := json.Marshal(partVars{Partitions: payload.Partitions})
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to marshal partition vars: %w", err))
	}

	varsPath, err := writeTempConfig(json.RawMessage(varsData))
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, err)
	}
	defer os.Remove(varsPath)

	streamFn := func(line string, seq int) {
		_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq)
	}

	opts := &ansible.RunOpts{
		PlaybookDir: h.playbookDir,
		Playbook:    "setup_partitions.yml",
		VarsFile:    varsPath,
		Inventory:   "localhost,",
	}

	result, err := h.runner.Run(ctx, opts, streamFn)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("setup_partitions playbook failed: %w", err))
	}
	if result.ExitCode != 0 {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("setup_partitions exited with code %d: %s", result.ExitCode, result.Stderr))
	}

	return h.publisher.SendResult(cmd.RequestID, result)
}

// probeNode returns true if ip is reachable via SSH.
// Ping is intentionally skipped — ICMP is commonly blocked in cloud security groups.
func (h *SetupHandler) probeNode(ctx context.Context, ip, sshKeyPath string, emit func(string)) bool {
	sshArgs := []string{
		"-o", "StrictHostKeyChecking=no",
		"-o", "UserKnownHostsFile=/dev/null",
		"-o", "ConnectTimeout=10",
		"-o", "BatchMode=yes",
	}
	if sshKeyPath != "" {
		sshArgs = append(sshArgs, "-i", sshKeyPath)
	}
	sshArgs = append(sshArgs, "root@"+ip, "exit 0")

	sshResult, err := slurm.RunCommand(ctx, "ssh", sshArgs...)
	if err != nil || sshResult.ExitCode != 0 {
		reason := sshResult.Stderr
		if reason == "" && err != nil {
			reason = err.Error()
		}
		emit(fmt.Sprintf("[aura] ✗ %s — SSH failed: %s", ip, strings.TrimSpace(reason)))
		return false
	}

	emit(fmt.Sprintf("[aura] ✓ %s — reachable via SSH", ip))
	return true
}

// buildInventory constructs an Ansible INI inventory from the node list.
func (h *SetupHandler) buildInventory(payload message.SetupNodesPayload) string {
	sshKeyArg := ""
	if _, err := os.Stat("/root/.ssh/aura_cluster_key"); err == nil {
		sshKeyArg = " ansible_ssh_private_key_file=/root/.ssh/aura_cluster_key"
	}

	var sb strings.Builder
	sb.WriteString("[slurm_controllers]\n")
	sb.WriteString("localhost ansible_connection=local\n\n")

	sb.WriteString("[slurm_workers]\n")
	for _, n := range payload.Nodes {
		if n.Hostname == payload.ControllerHostname && !payload.ControllerIsWorker {
			continue
		}
		sb.WriteString(fmt.Sprintf("%s ansible_host=%s ansible_user=root ansible_python_interpreter=/usr/bin/python3%s\n",
			n.Hostname, n.IP, sshKeyArg))
	}

	return sb.String()
}
