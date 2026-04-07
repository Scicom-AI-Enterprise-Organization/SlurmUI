package nats

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/scicom/aura/agent/internal/config"
)

// Client wraps a NATS connection and JetStream context.
type Client struct {
	conn   *nats.Conn
	js     jetstream.JetStream
	config *config.Config
	logger *slog.Logger
}

// NewClient creates a NATS connection and initializes JetStream.
func NewClient(cfg *config.Config, logger *slog.Logger) (*Client, error) {
	opts := []nats.Option{
		nats.Name(fmt.Sprintf("aura-agent-%s", cfg.ClusterID)),
		nats.ReconnectWait(2 * time.Second),
		nats.MaxReconnects(-1),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			logger.Warn("NATS disconnected", "error", err)
		}),
		nats.ReconnectHandler(func(_ *nats.Conn) {
			logger.Info("NATS reconnected")
		}),
		nats.ClosedHandler(func(_ *nats.Conn) {
			logger.Info("NATS connection closed")
		}),
	}

	nc, err := nats.Connect(cfg.NATSURL, opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to NATS at %s: %w", cfg.NATSURL, err)
	}

	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		return nil, fmt.Errorf("failed to create JetStream context: %w", err)
	}

	logger.Info("connected to NATS",
		"url", cfg.NATSURL,
		"cluster_id", cfg.ClusterID,
	)

	return &Client{
		conn:   nc,
		js:     js,
		config: cfg,
		logger: logger,
	}, nil
}

// JetStream returns the JetStream context.
func (c *Client) JetStream() jetstream.JetStream {
	return c.js
}

// Conn returns the underlying NATS connection.
func (c *Client) Conn() *nats.Conn {
	return c.conn
}

// Close drains and closes the NATS connection.
func (c *Client) Close() {
	if c.conn != nil {
		c.conn.Drain()
	}
}

// EnsureStream creates or updates the JetStream stream for this cluster.
func (c *Client) EnsureStream(ctx context.Context) error {
	streamName := fmt.Sprintf("AURA_CLUSTER_%s", c.config.ClusterID)

	_, err := c.js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name: streamName,
		Subjects: []string{
			c.config.CommandSubject(),
			c.config.DeploySubject(),
		},
		Retention:  jetstream.WorkQueuePolicy,
		MaxAge:     24 * time.Hour,
		Storage:    jetstream.FileStorage,
		Replicas:   1,
		Discard:    jetstream.DiscardOld,
		MaxMsgSize: 1 * 1024 * 1024,
	})
	if err != nil {
		return fmt.Errorf("failed to create/update stream %s: %w", streamName, err)
	}

	c.logger.Info("JetStream stream ready", "stream", streamName)
	return nil
}

// CreateCommandConsumer creates a durable pull consumer for the command subject.
func (c *Client) CreateCommandConsumer(ctx context.Context) (jetstream.Consumer, error) {
	streamName := fmt.Sprintf("AURA_CLUSTER_%s", c.config.ClusterID)
	consumerName := fmt.Sprintf("agent-%s-commands", c.config.ClusterID)

	consumer, err := c.js.CreateOrUpdateConsumer(ctx, streamName, jetstream.ConsumerConfig{
		Name:          consumerName,
		Durable:       consumerName,
		FilterSubject: c.config.CommandSubject(),
		AckPolicy:     jetstream.AckExplicitPolicy,
		MaxDeliver:    3,
		AckWait:       60 * time.Second,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create command consumer: %w", err)
	}

	c.logger.Info("command consumer ready", "consumer", consumerName)
	return consumer, nil
}

// CreateDeployConsumer creates a durable pull consumer for the deploy subject.
func (c *Client) CreateDeployConsumer(ctx context.Context) (jetstream.Consumer, error) {
	streamName := fmt.Sprintf("AURA_CLUSTER_%s", c.config.ClusterID)
	consumerName := fmt.Sprintf("agent-%s-deploy", c.config.ClusterID)

	consumer, err := c.js.CreateOrUpdateConsumer(ctx, streamName, jetstream.ConsumerConfig{
		Name:          consumerName,
		Durable:       consumerName,
		FilterSubject: c.config.DeploySubject(),
		AckPolicy:     jetstream.AckExplicitPolicy,
		MaxDeliver:    3,
		AckWait:       300 * time.Second, // ansible playbooks can take a while
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create deploy consumer: %w", err)
	}

	c.logger.Info("deploy consumer ready", "consumer", consumerName)
	return consumer, nil
}
