package nats

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"testing"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/scicom/aura/agent/internal/config"
	"github.com/scicom/aura/agent/internal/message"
)

// startEmbeddedNATS starts an in-process NATS server with JetStream enabled.
func startEmbeddedNATS(t *testing.T) (*natsserver.Server, string) {
	t.Helper()

	opts := &natsserver.Options{
		Host:      "127.0.0.1",
		Port:      -1, // random port
		JetStream: true,
		StoreDir:  t.TempDir(),
		NoLog:     true,
	}

	ns, err := natsserver.NewServer(opts)
	if err != nil {
		t.Fatalf("failed to create embedded NATS server: %v", err)
	}
	ns.Start()

	if !ns.ReadyForConnections(5 * time.Second) {
		t.Fatal("embedded NATS server not ready")
	}

	return ns, ns.ClientURL()
}

func TestClient_EnsureStreamAndConsumers(t *testing.T) {
	ns, url := startEmbeddedNATS(t)
	defer ns.Shutdown()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	cfg := &config.Config{
		NATSURL:            url,
		ClusterID:          "test-cluster",
		AnsiblePlaybookDir: "/tmp",
		SlurmUser:          "slurm",
	}

	client, err := NewClient(cfg, logger)
	if err != nil {
		t.Fatalf("failed to create client: %v", err)
	}
	defer client.Close()

	ctx := context.Background()

	// Ensure stream.
	if err := client.EnsureStream(ctx); err != nil {
		t.Fatalf("failed to ensure stream: %v", err)
	}

	// Create consumers.
	cmdConsumer, err := client.CreateCommandConsumer(ctx)
	if err != nil {
		t.Fatalf("failed to create command consumer: %v", err)
	}

	_, err = client.CreateDeployConsumer(ctx)
	if err != nil {
		t.Fatalf("failed to create deploy consumer: %v", err)
	}

	// Publish a command message.
	cmd := &message.Command{
		RequestID: "test-req-1",
		Type:      message.CmdListJobs,
		Payload:   json.RawMessage(`{}`),
	}
	data, _ := json.Marshal(cmd)

	nc := client.Conn()
	if err := nc.Publish(cfg.CommandSubject(), data); err != nil {
		t.Fatalf("failed to publish command: %v", err)
	}
	nc.Flush()

	// Fetch the message from the consumer.
	msgs, err := cmdConsumer.Fetch(1, jetstream.FetchMaxWait(3*time.Second))
	if err != nil {
		t.Fatalf("fetch failed: %v", err)
	}

	count := 0
	for msg := range msgs.Messages() {
		count++
		parsed, err := message.ParseCommand(msg.Data())
		if err != nil {
			t.Fatalf("failed to parse fetched message: %v", err)
		}
		if parsed.RequestID != "test-req-1" {
			t.Errorf("expected request_id 'test-req-1', got %q", parsed.RequestID)
		}
		if parsed.Type != message.CmdListJobs {
			t.Errorf("expected type 'list_jobs', got %q", parsed.Type)
		}
		msg.Ack()
	}

	if count != 1 {
		t.Errorf("expected 1 message, got %d", count)
	}
}

func TestHeartbeat_Integration(t *testing.T) {
	ns, url := startEmbeddedNATS(t)
	defer ns.Shutdown()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	cfg := &config.Config{
		NATSURL:   url,
		ClusterID: "test-cluster",
	}

	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer nc.Close()

	// Subscribe to heartbeat subject.
	hbCh := make(chan *nats.Msg, 5)
	sub, err := nc.ChanSubscribe(cfg.HeartbeatSubject(), hbCh)
	if err != nil {
		t.Fatalf("failed to subscribe: %v", err)
	}
	defer sub.Unsubscribe()

	// Start heartbeat with a short-lived context.
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	go StartHeartbeat(ctx, nc, cfg, "test-agent", "0.1.0", logger)

	// Should receive the initial heartbeat almost immediately.
	select {
	case msg := <-hbCh:
		var hb message.Heartbeat
		if err := json.Unmarshal(msg.Data, &hb); err != nil {
			t.Fatalf("failed to parse heartbeat: %v", err)
		}
		if hb.ClusterID != "test-cluster" {
			t.Errorf("expected cluster_id 'test-cluster', got %q", hb.ClusterID)
		}
		if hb.AgentID != "test-agent" {
			t.Errorf("expected agent_id 'test-agent', got %q", hb.AgentID)
		}
		if hb.Version != "0.1.0" {
			t.Errorf("expected version '0.1.0', got %q", hb.Version)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for heartbeat")
	}
}

func TestPublisher_Integration(t *testing.T) {
	ns, url := startEmbeddedNATS(t)
	defer ns.Shutdown()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	cfg := &config.Config{
		NATSURL:   url,
		ClusterID: "test-cluster",
	}

	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer nc.Close()

	pub := NewPublisher(nc, cfg, logger)

	// Subscribe to the reply subject.
	replyCh := make(chan *nats.Msg, 5)
	sub, err := nc.ChanSubscribe(cfg.ReplySubject("req-1"), replyCh)
	if err != nil {
		t.Fatalf("failed to subscribe: %v", err)
	}
	defer sub.Unsubscribe()

	// Send a result reply.
	err = pub.SendResult("req-1", map[string]string{"status": "ok"})
	if err != nil {
		t.Fatalf("failed to send result: %v", err)
	}

	select {
	case msg := <-replyCh:
		var reply message.Reply
		if err := json.Unmarshal(msg.Data, &reply); err != nil {
			t.Fatalf("failed to parse reply: %v", err)
		}
		if reply.Type != message.ReplyResult {
			t.Errorf("expected type 'result', got %q", reply.Type)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for reply")
	}
}
