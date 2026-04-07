package nats

import (
	"fmt"
	"log/slog"

	"github.com/scicom/aura/agent/internal/config"
	"github.com/scicom/aura/agent/internal/message"

	"github.com/nats-io/nats.go"
)

// Publisher sends replies and stream lines back to the web service over NATS.
type Publisher struct {
	conn   *nats.Conn
	config *config.Config
	logger *slog.Logger
}

// NewPublisher creates a Publisher.
func NewPublisher(conn *nats.Conn, cfg *config.Config, logger *slog.Logger) *Publisher {
	return &Publisher{
		conn:   conn,
		config: cfg,
		logger: logger,
	}
}

// SendReply publishes a Reply message to the reply subject for a given request.
func (p *Publisher) SendReply(requestID string, reply *message.Reply) error {
	data, err := message.MarshalReply(reply)
	if err != nil {
		return fmt.Errorf("failed to marshal reply: %w", err)
	}

	subject := p.config.ReplySubject(requestID)
	if err := p.conn.Publish(subject, data); err != nil {
		return fmt.Errorf("failed to publish reply to %s: %w", subject, err)
	}

	p.logger.Debug("published reply",
		"subject", subject,
		"request_id", requestID,
		"type", reply.Type,
	)
	return nil
}

// SendStreamLine publishes a single stdout line to the stream subject.
func (p *Publisher) SendStreamLine(requestID string, line string, seq int) error {
	sl := &message.StreamLine{
		RequestID: requestID,
		Line:      line,
		Seq:       seq,
	}

	data, err := message.MarshalStreamLine(sl)
	if err != nil {
		return fmt.Errorf("failed to marshal stream line: %w", err)
	}

	subject := p.config.StreamSubject(requestID)
	if err := p.conn.Publish(subject, data); err != nil {
		return fmt.Errorf("failed to publish stream line to %s: %w", subject, err)
	}

	return nil
}

// SendResult is a convenience method that sends a success reply.
func (p *Publisher) SendResult(requestID string, payload interface{}) error {
	return p.SendReply(requestID, message.NewResultReply(requestID, payload))
}

// SendError is a convenience method that sends an error reply.
func (p *Publisher) SendError(requestID string, err error) error {
	return p.SendReply(requestID, message.NewErrorReply(requestID, err))
}
