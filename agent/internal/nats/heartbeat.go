package nats

import (
	"context"
	"log/slog"
	"time"

	"github.com/scicom/aura/agent/internal/config"
	"github.com/scicom/aura/agent/internal/message"

	natspkg "github.com/nats-io/nats.go"
)

// StartHeartbeat publishes a heartbeat message every 10 seconds until ctx is cancelled.
// It runs in a blocking loop — call it in a goroutine.
func StartHeartbeat(ctx context.Context, conn *natspkg.Conn, cfg *config.Config, agentID string, version string, logger *slog.Logger) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	subject := cfg.HeartbeatSubject()
	logger.Info("heartbeat started", "subject", subject, "interval", "10s")

	// Send an initial heartbeat immediately.
	publishHeartbeat(conn, subject, cfg.ClusterID, agentID, version, logger)

	for {
		select {
		case <-ctx.Done():
			logger.Info("heartbeat stopped")
			return
		case <-ticker.C:
			publishHeartbeat(conn, subject, cfg.ClusterID, agentID, version, logger)
		}
	}
}

func publishHeartbeat(conn *natspkg.Conn, subject, clusterID, agentID, version string, logger *slog.Logger) {
	hb := &message.Heartbeat{
		ClusterID: clusterID,
		AgentID:   agentID,
		Timestamp: time.Now().UTC(),
		Version:   version,
	}

	data, err := message.MarshalHeartbeat(hb)
	if err != nil {
		logger.Error("failed to marshal heartbeat", "error", err)
		return
	}

	if err := conn.Publish(subject, data); err != nil {
		logger.Error("failed to publish heartbeat", "error", err)
		return
	}

	logger.Debug("heartbeat sent", "agent_id", agentID)
}
