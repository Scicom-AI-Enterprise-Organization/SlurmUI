package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/scicom/aura/agent/internal/ansible"
	"github.com/scicom/aura/agent/internal/config"
	"github.com/scicom/aura/agent/internal/handler"
	"github.com/scicom/aura/agent/internal/message"
	agentNats "github.com/scicom/aura/agent/internal/nats"
)

var Version = "dev"

func main() {
	// Structured logger.
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	logger.Info("aura-agent starting", "version", Version)

	// Load config from environment.
	cfg, err := config.Load()
	if err != nil {
		logger.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	// Generate a unique agent ID for this instance.
	agentID := uuid.New().String()
	logger.Info("agent initialized",
		"agent_id", agentID,
		"cluster_id", cfg.ClusterID,
	)

	// Context with cancellation for graceful shutdown.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Handle OS signals.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		logger.Info("received signal, shutting down", "signal", sig)
		cancel()
	}()

	// Connect to NATS.
	natsClient, err := agentNats.NewClient(cfg, logger)
	if err != nil {
		logger.Error("failed to connect to NATS", "error", err)
		os.Exit(1)
	}
	defer natsClient.Close()

	// Ensure JetStream stream exists.
	if err := natsClient.EnsureStream(ctx); err != nil {
		logger.Error("failed to ensure JetStream stream", "error", err)
		os.Exit(1)
	}

	// Create consumers.
	commandConsumer, err := natsClient.CreateCommandConsumer(ctx)
	if err != nil {
		logger.Error("failed to create command consumer", "error", err)
		os.Exit(1)
	}

	deployConsumer, err := natsClient.CreateDeployConsumer(ctx)
	if err != nil {
		logger.Error("failed to create deploy consumer", "error", err)
		os.Exit(1)
	}

	// Build handler chain.
	publisher := agentNats.NewPublisher(natsClient.Conn(), cfg, logger)
	ansibleRunner := ansible.NewRunner(logger)
	slurmHandler := handler.NewSlurmHandler(publisher, logger)
	deployHandler := handler.NewDeployHandler(publisher, ansibleRunner, cfg.AnsiblePlaybookDir, logger)
	dispatcher := handler.NewDispatcher(slurmHandler, deployHandler, publisher, logger)

	// Start heartbeat.
	go agentNats.StartHeartbeat(ctx, natsClient.Conn(), cfg, agentID, Version, logger)

	// Start consuming commands.
	go consumeMessages(ctx, commandConsumer, dispatcher, logger)
	go consumeMessages(ctx, deployConsumer, dispatcher, logger)

	logger.Info("aura-agent running",
		"cluster_id", cfg.ClusterID,
		"nats_url", cfg.NATSURL,
	)

	// Block until context is cancelled.
	<-ctx.Done()
	logger.Info("aura-agent stopped")
}

// consumeMessages pulls messages from a JetStream consumer and dispatches them.
func consumeMessages(ctx context.Context, consumer jetstream.Consumer, dispatcher *handler.Dispatcher, logger *slog.Logger) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		msgs, err := consumer.Fetch(1, jetstream.FetchMaxWait(5000000000)) // 5 seconds
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			logger.Debug("fetch returned no messages", "error", err)
			continue
		}

		for msg := range msgs.Messages() {
			cmd, err := message.ParseCommand(msg.Data())
			if err != nil {
				logger.Error("failed to parse message", "error", err, "data", string(msg.Data()))
				msg.Nak()
				continue
			}

			if err := dispatcher.Dispatch(ctx, cmd); err != nil {
				logger.Error("handler error",
					"request_id", cmd.RequestID,
					"type", cmd.Type,
					"error", err,
				)
			}

			msg.Ack()
		}

		if err := msgs.Error(); err != nil {
			if ctx.Err() != nil {
				return
			}
			logger.Debug("message batch error", "error", err)
		}
	}
}
