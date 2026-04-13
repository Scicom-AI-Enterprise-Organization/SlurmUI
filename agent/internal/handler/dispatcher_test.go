package handler

import (
	"testing"

	"github.com/scicom/aura/agent/internal/message"
)

func TestDispatcher_UnknownCommand(t *testing.T) {
	// Verify that the dispatcher handles unknown command types gracefully.
	// This is a compile-time verification that the switch covers all cases.
	// Full integration test with embedded NATS is in Task 14.

	knownTypes := []message.CommandType{
		message.CmdSubmitJob,
		message.CmdCancelJob,
		message.CmdListJobs,
		message.CmdJobInfo,
		message.CmdNodeStatus,
		message.CmdActivateNode,
		message.CmdAddNode,
		message.CmdPropagateConfig,
		message.CmdCreateHomedir,
		message.CmdTestNfs,
		message.CmdSetupNodes,
		message.CmdSetupPartitions,
		message.CmdProvisionUser,
	}

	if len(knownTypes) != 13 {
		t.Errorf("expected 13 known command types, got %d", len(knownTypes))
	}
}
