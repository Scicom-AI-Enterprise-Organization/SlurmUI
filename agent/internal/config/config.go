package config

import (
	"fmt"
	"os"
)

// Config holds all agent configuration loaded from environment variables.
type Config struct {
	// NATS_URL is the NATS server URL (e.g., nats://aura-web.scicom.internal:4222).
	NATSURL string

	// CLUSTER_ID identifies this Slurm cluster (e.g., sci-cluster-01).
	ClusterID string

	// ANSIBLE_PLAYBOOK_DIR is the directory containing Ansible playbooks.
	AnsiblePlaybookDir string

	// SLURM_USER is the OS user for running Slurm commands.
	SlurmUser string
}

// Load reads configuration from environment variables.
// Returns an error if any required variable is missing.
func Load() (*Config, error) {
	cfg := &Config{
		NATSURL:            os.Getenv("NATS_URL"),
		ClusterID:          os.Getenv("CLUSTER_ID"),
		AnsiblePlaybookDir: os.Getenv("ANSIBLE_PLAYBOOK_DIR"),
		SlurmUser:          os.Getenv("SLURM_USER"),
	}

	if cfg.NATSURL == "" {
		return nil, fmt.Errorf("NATS_URL environment variable is required")
	}
	if cfg.ClusterID == "" {
		return nil, fmt.Errorf("CLUSTER_ID environment variable is required")
	}
	if cfg.AnsiblePlaybookDir == "" {
		cfg.AnsiblePlaybookDir = "/opt/aura/ansible"
	}
	if cfg.SlurmUser == "" {
		cfg.SlurmUser = "slurm"
	}

	return cfg, nil
}

// Subjects returns the NATS subject strings for this cluster.
func (c *Config) CommandSubject() string {
	return fmt.Sprintf("aura.cluster.%s.command", c.ClusterID)
}

func (c *Config) ReplySubject(requestID string) string {
	return fmt.Sprintf("aura.cluster.%s.reply.%s", c.ClusterID, requestID)
}

func (c *Config) StreamSubject(requestID string) string {
	return fmt.Sprintf("aura.cluster.%s.stream.%s", c.ClusterID, requestID)
}

func (c *Config) HeartbeatSubject() string {
	return fmt.Sprintf("aura.cluster.%s.heartbeat", c.ClusterID)
}

func (c *Config) DeploySubject() string {
	return fmt.Sprintf("aura.deploy.%s", c.ClusterID)
}
