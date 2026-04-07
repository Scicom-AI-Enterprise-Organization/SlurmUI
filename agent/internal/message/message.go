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
	Script    string            `json:"script"`     // sbatch script content
	WorkDir   string            `json:"work_dir"`   // working directory
	JobName   string            `json:"job_name"`   // --job-name
	Partition string            `json:"partition"`   // --partition
	Nodes     int               `json:"nodes"`       // --nodes
	NTasks    int               `json:"ntasks"`      // --ntasks
	GPUs      string            `json:"gpus"`        // --gpus
	TimeLimit string            `json:"time_limit"`  // --time
	ExtraArgs []string          `json:"extra_args"`  // additional sbatch flags
	EnvVars   map[string]string `json:"env_vars"`    // --export
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
	TargetNode string `json:"target_node"`
	VarsFile   string `json:"vars_file"` // path to cluster-config.json on disk
}

// AddNodePayload is the payload for add_node commands.
type AddNodePayload struct {
	TargetNode string `json:"target_node"`
	VarsFile   string `json:"vars_file"`
}

// PropagateConfigPayload is the payload for propagate_config commands.
type PropagateConfigPayload struct {
	VarsFile string `json:"vars_file"`
}

// CreateHomedirPayload is the payload for create_homedir commands.
type CreateHomedirPayload struct {
	Username string `json:"username"`
	UserUID  int    `json:"user_uid"`
	UserGID  int    `json:"user_gid"`
	VarsFile string `json:"vars_file"`
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
