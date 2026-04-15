package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
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
		ClusterName        string              `json:"cluster_name"`
		ControllerHostname string              `json:"controller_hostname"`
		ControllerIsWorker bool                `json:"controller_is_worker"`
		Nodes              []message.NodeEntry `json:"nodes"`
		MgmtNfsServer      string              `json:"mgmt_nfs_server"`
		MgmtNfsPath        string              `json:"mgmt_nfs_path"`
		DataNfsServer      string              `json:"data_nfs_server"`
		DataNfsPath        string              `json:"data_nfs_path"`
	}
	vars := nodeVars{
		ClusterName:        payload.ClusterName,
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

// HandleTeardown removes all Aura-installed Slurm config from every node and
// then self-uninstalls the agent from the controller.
func (h *SetupHandler) HandleTeardown(ctx context.Context, cmd *message.Command) error {
	var payload message.TeardownPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid teardown payload: %w", err))
	}

	h.logger.Info("tearing down cluster", "request_id", cmd.RequestID, "workers", len(payload.Nodes))

	seq := 0
	emit := func(line string) {
		_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq)
		seq++
	}

	// Save SSH key if provided.
	sshKeyPath := ""
	if payload.SSHPrivateKey != "" {
		keyBytes, err := base64.StdEncoding.DecodeString(payload.SSHPrivateKey)
		if err != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to decode SSH key: %w", err))
		}
		sshKeyPath = "/root/.ssh/aura_cluster_key"
		if err := os.WriteFile(sshKeyPath, keyBytes, 0600); err != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to write SSH key: %w", err))
		}
		emit("[aura] SSH key loaded")
	}

	// Build inventory: controller (localhost) + workers.
	sshKeyArg := ""
	if sshKeyPath != "" {
		sshKeyArg = " ansible_ssh_private_key_file=" + sshKeyPath
	}
	var sb strings.Builder
	sb.WriteString("[slurm_controllers]\n")
	sb.WriteString("localhost ansible_connection=local\n\n")
	sb.WriteString("[slurm_workers]\n")
	for _, n := range payload.Nodes {
		sb.WriteString(fmt.Sprintf(
			"%s ansible_host=%s ansible_user=root ansible_python_interpreter=/usr/bin/python3%s\n",
			n.Hostname, n.IP, sshKeyArg,
		))
	}

	invFile, err := os.CreateTemp("", "aura-teardown-inv-*.ini")
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to create inventory: %w", err))
	}
	invFile.WriteString(sb.String())
	invFile.Close()
	defer os.Remove(invFile.Name())

	// Write vars file.
	type teardownVars struct {
		MgmtNfsPath string `json:"mgmt_nfs_path"`
		DataNfsPath string `json:"data_nfs_path"`
	}
	varsData, err := json.Marshal(teardownVars{
		MgmtNfsPath: payload.MgmtNfsPath,
		DataNfsPath: payload.DataNfsPath,
	})
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to marshal vars: %w", err))
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
		Playbook:    "teardown.yml",
		VarsFile:    varsPath,
		Inventory:   invFile.Name(),
	}

	emit("[aura] Starting teardown playbook...")
	result, err := h.runner.Run(ctx, opts, streamFn)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("teardown playbook failed: %w", err))
	}
	if result.ExitCode != 0 {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("teardown exited with code %d: %s", result.ExitCode, result.Stderr))
	}

	emit("[aura] Teardown complete. Scheduling agent self-uninstall...")

	// Send success reply BEFORE uninstalling — gives NATS time to deliver.
	if sendErr := h.publisher.SendResult(cmd.RequestID, map[string]string{"status": "ok"}); sendErr != nil {
		h.logger.Error("failed to send teardown result", "error", sendErr)
	}

	// Schedule agent self-uninstall via a transient systemd unit so the cleanup
	// runs outside the agent's cgroup. Using Setsid alone is not enough — when
	// systemd stops aura-agent.service it kills the entire cgroup, which would
	// terminate a plain bash subprocess before it can finish.
	cleanup := "sleep 5;" +
		"systemctl stop aura-agent 2>/dev/null || true;" +
		"systemctl disable aura-agent 2>/dev/null || true;" +
		"rm -f /etc/systemd/system/aura-agent.service;" +
		"systemctl daemon-reload 2>/dev/null || true;" +
		"rm -rf /opt/aura /etc/aura-agent;" +
		"rm -f /usr/local/bin/aura-agent"
	selfCleanup := exec.Command("systemd-run", "--no-block", "--unit=aura-cleanup",
		"bash", "-c", cleanup)
	_ = selfCleanup.Start()

	return nil
}

// HandleClusterHealth runs sinfo and squeue, streaming their output as log lines.
func (h *SetupHandler) HandleClusterHealth(ctx context.Context, cmd *message.Command) error {
	h.logger.Info("running cluster health check", "request_id", cmd.RequestID)

	seq := 0
	emit := func(line string) {
		_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq)
		seq++
	}

	emit("[aura] Running sinfo...")
	sinfoResult, err := slurm.RunCommand(ctx, "sinfo")
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("sinfo failed: %w", err))
	}
	if sinfoResult.ExitCode != 0 {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("sinfo failed (exit %d): %s", sinfoResult.ExitCode, sinfoResult.Stderr))
	}
	for _, line := range strings.Split(strings.TrimRight(sinfoResult.Stdout, "\n"), "\n") {
		if line != "" {
			emit(line)
		}
	}

	emit("[aura] Running squeue...")
	squeueResult, err := slurm.RunCommand(ctx, "squeue")
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("squeue failed: %w", err))
	}
	for _, line := range strings.Split(strings.TrimRight(squeueResult.Stdout, "\n"), "\n") {
		if line != "" {
			emit(line)
		}
	}

	emit("[aura] Slurm health OK")
	return h.publisher.SendResult(cmd.RequestID, map[string]string{"status": "ok"})
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

// HandleInstallPackages checks each package exists on the controller via apt-cache,
// then installs them across all cluster nodes (controller + workers) via Ansible.
func (h *SetupHandler) HandleInstallPackages(ctx context.Context, cmd *message.Command) error {
	var payload message.InstallPackagesPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid install_packages payload: %w", err))
	}
	if len(payload.Packages) == 0 {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("no packages specified"))
	}

	h.logger.Info("installing packages", "request_id", cmd.RequestID, "packages", payload.Packages)

	seq := 0
	emit := func(line string) {
		_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq)
		seq++
	}

	// Validate that each package is known to apt on the controller.
	emit("[aura] Checking packages against apt cache...")
	for _, pkg := range payload.Packages {
		result, err := slurm.RunCommand(ctx, "apt-cache", "show", pkg)
		if err != nil || result.ExitCode != 0 {
			return h.publisher.SendError(cmd.RequestID,
				fmt.Errorf("package %q not found in apt cache — check the package name and try again", pkg))
		}
		emit(fmt.Sprintf("[aura] ✓ %s found in apt cache", pkg))
	}

	// Save SSH key if provided.
	sshKeyPath := "/root/.ssh/aura_cluster_key"
	if payload.SSHPrivateKey != "" {
		keyBytes, err := base64.StdEncoding.DecodeString(payload.SSHPrivateKey)
		if err != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to decode SSH key: %w", err))
		}
		if err := os.MkdirAll("/root/.ssh", 0700); err != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to create .ssh dir: %w", err))
		}
		if err := os.WriteFile(sshKeyPath, keyBytes, 0600); err != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to write SSH key: %w", err))
		}
	}

	// Build inventory: controller (localhost) + workers.
	sshKeyArg := ""
	if _, err := os.Stat(sshKeyPath); err == nil {
		sshKeyArg = " ansible_ssh_private_key_file=" + sshKeyPath
	}
	var sb strings.Builder
	sb.WriteString("[all]\n")
	sb.WriteString("localhost ansible_connection=local\n")
	for _, w := range payload.WorkerHosts {
		sb.WriteString(fmt.Sprintf(
			"%s ansible_host=%s ansible_user=root ansible_python_interpreter=/usr/bin/python3%s\n",
			w.Hostname, w.IP, sshKeyArg,
		))
	}

	invFile, err := os.CreateTemp("", "aura-pkg-inv-*.ini")
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to create inventory: %w", err))
	}
	invFile.WriteString(sb.String())
	invFile.Close()
	defer os.Remove(invFile.Name())

	// Write vars file with the package list so Ansible receives it as a proper list.
	pkgVarsData, _ := json.Marshal(map[string]interface{}{"packages": payload.Packages})
	varsPath, err := writeTempConfig(json.RawMessage(pkgVarsData))
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, err)
	}
	defer os.Remove(varsPath)

	streamFn := func(line string, s int) {
		_ = h.publisher.SendStreamLine(cmd.RequestID, line, s)
	}

	emit(fmt.Sprintf("[aura] Installing %v on all nodes...", payload.Packages))

	opts := &ansible.RunOpts{
		PlaybookDir: h.playbookDir,
		Playbook:    "install_packages.yml",
		Inventory:   invFile.Name(),
		VarsFile:    varsPath,
	}

	result, err := h.runner.Run(ctx, opts, streamFn)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("install_packages playbook failed: %w", err))
	}
	if result.ExitCode != 0 {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("install_packages exited with code %d", result.ExitCode))
	}

	return h.publisher.SendResult(cmd.RequestID, map[string]interface{}{
		"status":   "ok",
		"packages": payload.Packages,
	})
}
