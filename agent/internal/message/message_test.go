package message

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestParseCommand_Valid(t *testing.T) {
	raw := `{"request_id":"abc-123","type":"list_jobs","payload":{}}`
	cmd, err := ParseCommand([]byte(raw))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cmd.RequestID != "abc-123" {
		t.Errorf("expected request_id 'abc-123', got %q", cmd.RequestID)
	}
	if cmd.Type != CmdListJobs {
		t.Errorf("expected type 'list_jobs', got %q", cmd.Type)
	}
}

func TestParseCommand_MissingRequestID(t *testing.T) {
	raw := `{"type":"list_jobs","payload":{}}`
	_, err := ParseCommand([]byte(raw))
	if err == nil {
		t.Fatal("expected error for missing request_id")
	}
}

func TestParseCommand_MissingType(t *testing.T) {
	raw := `{"request_id":"abc-123","payload":{}}`
	_, err := ParseCommand([]byte(raw))
	if err == nil {
		t.Fatal("expected error for missing type")
	}
}

func TestParseCommand_InvalidJSON(t *testing.T) {
	raw := `not json`
	_, err := ParseCommand([]byte(raw))
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestNewResultReply(t *testing.T) {
	reply := NewResultReply("req-1", map[string]string{"status": "ok"})
	if reply.RequestID != "req-1" {
		t.Errorf("expected request_id 'req-1', got %q", reply.RequestID)
	}
	if reply.Type != ReplyResult {
		t.Errorf("expected type 'result', got %q", reply.Type)
	}
}

func TestNewErrorReply(t *testing.T) {
	reply := NewErrorReply("req-2", fmt.Errorf("something broke"))
	if reply.Type != ReplyError {
		t.Errorf("expected type 'error', got %q", reply.Type)
	}

	data, _ := json.Marshal(reply.Payload)
	if string(data) != `{"error":"something broke"}` {
		t.Errorf("unexpected payload: %s", data)
	}
}

func TestMarshalStreamLine(t *testing.T) {
	sl := &StreamLine{
		RequestID: "req-3",
		Line:      "hello output",
		Seq:       5,
	}
	data, err := MarshalStreamLine(sl)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]interface{}
	json.Unmarshal(data, &parsed)
	if parsed["request_id"] != "req-3" {
		t.Errorf("unexpected request_id: %v", parsed["request_id"])
	}
	if parsed["line"] != "hello output" {
		t.Errorf("unexpected line: %v", parsed["line"])
	}
	if parsed["seq"] != float64(5) {
		t.Errorf("unexpected seq: %v", parsed["seq"])
	}
}

func TestSubmitJobPayload_Unmarshal(t *testing.T) {
	raw := `{"script":"#!/bin/bash\necho hi","job_name":"test","partition":"gpu"}`
	var payload SubmitJobPayload
	err := json.Unmarshal([]byte(raw), &payload)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if payload.JobName != "test" {
		t.Errorf("expected job_name 'test', got %q", payload.JobName)
	}
	if payload.Partition != "gpu" {
		t.Errorf("expected partition 'gpu', got %q", payload.Partition)
	}
}
