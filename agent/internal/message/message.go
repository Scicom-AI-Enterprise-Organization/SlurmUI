package message

import (
	"encoding/json"
	"fmt"
	"time"
)

// CommandType enumerates all known command types.
type CommandType string

const (
	// Slurm commands
	CmdSubmitJob  CommandType = "submit_job"
	CmdCancelJob  CommandType = "cancel_job"
	CmdListJobs   CommandType = "list_jobs"
	CmdJobInfo    CommandType = "job_info"
	CmdNodeStatus CommandType = "node_status"

	// Deploy commands
	CmdActivateNode    CommandType = "activate_node"
	CmdAddNode         CommandType = "add_node"
	CmdPropagateConfig CommandType = "propagate_config"
	CmdCreateHomedir   CommandType = "create_homedir"

	// Setup commands (Phase 2 guided setup)
	CmdTestNfs         CommandType = "test_nfs"
	CmdSetupNodes      CommandType = "setup_nodes"
	CmdSetupPartitions CommandType = "setup_partitions"
	CmdClusterHealth   CommandType = "cluster_health"
	CmdTeardown        CommandType = "teardown"

	// User provisioning
	CmdProvisionUser   CommandType = "provision_user"
	CmdDeprovisionUser CommandType = "deprovision_user"

	// Job output streaming
	CmdWatchJob CommandType = "watch_job"
)

// ReplyType enumerates reply types.
type ReplyType string

const (
	ReplyResult ReplyType = "result"
	ReplyError  ReplyType = "error"
)

// Command is the message received from the web service.
type Command struct {
	RequestID string          `json:"request_id"`
	Type      CommandType     `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

// Reply is the response sent back to the web service.
type Reply struct {
	RequestID string      `json:"request_id"`
	Type      ReplyType   `json:"type"`
	Payload   interface{} `json:"payload"`
}

// StreamLine is a single line of stdout sent during live streaming.
type StreamLine struct {
	RequestID string `json:"request_id"`
	Line      string `json:"line"`
	Seq       int    `json:"seq"`
}

// Heartbeat is the periodic liveness signal sent to the web service.
type Heartbeat struct {
	ClusterID string    `json:"cluster_id"`
	AgentID   string    `json:"agent_id"`
	Timestamp time.Time `json:"timestamp"`
	Version   string    `json:"version"`
}

// --- Slurm command payloads ---

// SubmitJobPayload is the payload for submit_job commands.
type SubmitJobPayload struct {
	Script    string            `json:"script"`      // sbatch script content
	WorkDir   string            `json:"work_dir"`    // working directory
	JobName   string            `json:"job_name"`    // --job-name
	Partition string            `json:"partition"`   // --partition
	Nodes     int               `json:"nodes"`       // --nodes
	NTasks    int               `json:"ntasks"`      // --ntasks
	GPUs      string            `json:"gpus"`        // --gpus
	TimeLimit string            `json:"time_limit"`  // --time
	ExtraArgs []string          `json:"extra_args"`  // additional sbatch flags
	EnvVars   map[string]string `json:"env_vars"`    // --export
	OutputDir string            `json:"output_dir"`  // shared NFS dir for job output
	Username  string            `json:"username"`    // Linux user to run sbatch as (sudo -u)
}

// CancelJobPayload is the payload for cancel_job commands.
type CancelJobPayload struct {
	JobID string `json:"job_id"`
}

// JobInfoPayload is the payload for job_info commands.
type JobInfoPayload struct {
	JobID string `json:"job_id"`
}

// ListJobsPayload is the payload for list_jobs commands (optional filters).
type ListJobsPayload struct {
	User      string `json:"user,omitempty"`
	Partition string `json:"partition,omitempty"`
}

// --- Deploy command payloads ---

// ActivateNodePayload is the payload for activate_node commands.
type ActivateNodePayload struct {
	TargetNode string          `json:"target_node"`
	VarsFile   string          `json:"vars_file,omitempty"` // path to cluster-config.json on disk
	Config     json.RawMessage `json:"config,omitempty"`    // inline config (alternative to VarsFile)
}

// AddNodePayload is the payload for add_node commands.
type AddNodePayload struct {
	TargetNode string          `json:"target_node"`
	VarsFile   string          `json:"vars_file,omitempty"`
	Config     json.RawMessage `json:"config,omitempty"`
}

// PropagateConfigPayload is the payload for propagate_config commands.
type PropagateConfigPayload struct {
	VarsFile string          `json:"vars_file,omitempty"`
	Config   json.RawMessage `json:"config,omitempty"`
}

// CreateHomedirPayload is the payload for create_homedir commands.
type CreateHomedirPayload struct {
	Username string          `json:"username"`
	UserUID  int             `json:"user_uid"`
	UserGID  int             `json:"user_gid"`
	VarsFile string          `json:"vars_file,omitempty"`
	Config   json.RawMessage `json:"config,omitempty"`
}

// TestNfsPayload is the payload for test_nfs commands.
type TestNfsPayload struct {
	MgmtNfsServer string `json:"mgmt_nfs_server"`
	MgmtNfsPath   string `json:"mgmt_nfs_path"`
	DataNfsServer string `json:"data_nfs_server"`
	DataNfsPath   string `json:"data_nfs_path"`
}

// NodeEntry represents a single node definition for setup_nodes.
type NodeEntry struct {
	Hostname string `json:"hostname"`
	IP       string `json:"ip"`
	CPUs     int    `json:"cpus"`
	MemoryMB int    `json:"memory_mb"`
	GPUs     int    `json:"gpus"`
}

// SetupNodesPayload is the payload for setup_nodes commands.
type SetupNodesPayload struct {
	ClusterName        string      `json:"cluster_name"`
	ControllerHostname string      `json:"controller_hostname"`
	ControllerIsWorker bool        `json:"controller_is_worker"`
	Nodes              []NodeEntry `json:"nodes"`
	SSHPrivateKey      string      `json:"ssh_private_key,omitempty"` // base64-encoded, saved for Ansible
	// NFS config — passed to Ansible so workers get mounts
	MgmtNfsServer string `json:"mgmt_nfs_server,omitempty"`
	MgmtNfsPath   string `json:"mgmt_nfs_path,omitempty"`
	DataNfsServer string `json:"data_nfs_server,omitempty"`
	DataNfsPath   string `json:"data_nfs_path,omitempty"`
}

// PartitionDef defines a Slurm partition.
type PartitionDef struct {
	Name    string `json:"name"`
	Nodes   string `json:"nodes"`
	MaxTime string `json:"max_time"`
	Default bool   `json:"default"`
}

// SetupPartitionsPayload is the payload for setup_partitions commands.
type SetupPartitionsPayload struct {
	Partitions []PartitionDef `json:"partitions"`
}

// WatchJobPayload is the payload for watch_job commands.
type WatchJobPayload struct {
	SlurmJobID int    `json:"slurm_job_id"`
	OutputFile string `json:"output_file"`
}

// TeardownPayload is the payload for teardown commands.
type TeardownPayload struct {
	Nodes         []NodeEntry `json:"nodes"`
	SSHPrivateKey string      `json:"ssh_private_key,omitempty"` // base64-encoded
	MgmtNfsPath   string      `json:"mgmt_nfs_path,omitempty"`
	DataNfsPath   string      `json:"data_nfs_path,omitempty"`
}

// WorkerHost is a hostname/IP pair for Ansible inventory.
type WorkerHost struct {
	Hostname string `json:"hostname"`
	IP       string `json:"ip"`
}

// ProvisionUserPayload is the payload for provision_user commands.
type ProvisionUserPayload struct {
	Username    string       `json:"username"`
	UID         int          `json:"uid"`
	GID         int          `json:"gid"`
	NfsHome     string       `json:"nfs_home"`
	WorkerHosts []WorkerHost `json:"worker_hosts"`
}

// DeprovisionUserPayload is the payload for deprovision_user commands.
type DeprovisionUserPayload struct {
	Username    string       `json:"username"`
	UID         int          `json:"uid"`
	GID         int          `json:"gid"`
	NfsHome     string       `json:"nfs_home"`
	WorkerHosts []WorkerHost `json:"worker_hosts"`
}

// ParseCommand parses a raw JSON message into a Command.
func ParseCommand(data []byte) (*Command, error) {
	var cmd Command
	if err := json.Unmarshal(data, &cmd); err != nil {
		return nil, fmt.Errorf("failed to parse command: %w", err)
	}
	if cmd.RequestID == "" {
		return nil, fmt.Errorf("command missing request_id")
	}
	if cmd.Type == "" {
		return nil, fmt.Errorf("command missing type")
	}
	return &cmd, nil
}

// MarshalReply serializes a Reply to JSON.
func MarshalReply(r *Reply) ([]byte, error) {
	return json.Marshal(r)
}

// MarshalStreamLine serializes a StreamLine to JSON.
func MarshalStreamLine(s *StreamLine) ([]byte, error) {
	return json.Marshal(s)
}

// MarshalHeartbeat serializes a Heartbeat to JSON.
func MarshalHeartbeat(h *Heartbeat) ([]byte, error) {
	return json.Marshal(h)
}

// NewResultReply creates a success reply.
func NewResultReply(requestID string, payload interface{}) *Reply {
	return &Reply{
		RequestID: requestID,
		Type:      ReplyResult,
		Payload:   payload,
	}
}

// NewErrorReply creates an error reply.
func NewErrorReply(requestID string, err error) *Reply {
	return &Reply{
		RequestID: requestID,
		Type:      ReplyError,
		Payload:   map[string]string{"error": err.Error()},
	}
}
