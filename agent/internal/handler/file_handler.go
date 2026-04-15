package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/scicom/aura/agent/internal/message"
	agentNats "github.com/scicom/aura/agent/internal/nats"
)

const maxDownloadBytes = 100 * 1024 * 1024 // 100 MB

// FileHandler handles file-system read operations on the NFS share.
type FileHandler struct {
	publisher *agentNats.Publisher
	logger    *slog.Logger
}

func NewFileHandler(publisher *agentNats.Publisher, logger *slog.Logger) *FileHandler {
	return &FileHandler{publisher: publisher, logger: logger}
}

// safeJoin ensures that joining nfsHome + relPath cannot escape nfsHome.
// Returns the absolute path or an error if traversal is detected.
func safeJoin(nfsHome, relPath string) (string, error) {
	// Strip any leading slashes so filepath.Join treats it as relative.
	cleaned := filepath.Clean("/" + relPath)
	abs := filepath.Join(nfsHome, cleaned)
	if !strings.HasPrefix(abs+string(filepath.Separator), filepath.Clean(nfsHome)+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes home directory")
	}
	return abs, nil
}

// HandleListFiles lists the contents of a directory inside the user's NFS home.
func (h *FileHandler) HandleListFiles(ctx context.Context, cmd *message.Command) error {
	var payload message.ListFilesPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid list_files payload: %w", err))
	}

	h.logger.Info("listing files", "request_id", cmd.RequestID, "path", payload.Path)

	absPath, err := safeJoin(payload.NfsHome, payload.Path)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, err)
	}

	entries, err := os.ReadDir(absPath)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("cannot read directory: %w", err))
	}

	result := make([]message.FileEntry, 0, len(entries))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		result = append(result, message.FileEntry{
			Name:     e.Name(),
			IsDir:    e.IsDir(),
			Size:     info.Size(),
			Modified: info.ModTime().UTC().Format("2006-01-02T15:04:05Z"),
			Mode:     info.Mode().String(),
		})
	}

	return h.publisher.SendResult(cmd.RequestID, map[string]interface{}{
		"entries": result,
		"path":    payload.Path,
	})
}

// HandleReadFile reads a file and returns its content as base64.
// Rejects files larger than maxDownloadBytes.
func (h *FileHandler) HandleReadFile(ctx context.Context, cmd *message.Command) error {
	var payload message.ReadFilePayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid read_file payload: %w", err))
	}

	h.logger.Info("reading file", "request_id", cmd.RequestID, "path", payload.Path)

	absPath, err := safeJoin(payload.NfsHome, payload.Path)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, err)
	}

	info, err := os.Stat(absPath)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("file not found: %w", err))
	}
	if info.IsDir() {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("path is a directory, not a file"))
	}
	if info.Size() > maxDownloadBytes {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("file too large (%d bytes, max %d)", info.Size(), maxDownloadBytes))
	}

	data, err := os.ReadFile(absPath)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("cannot read file: %w", err))
	}

	return h.publisher.SendResult(cmd.RequestID, map[string]interface{}{
		"name":    filepath.Base(absPath),
		"content": base64.StdEncoding.EncodeToString(data),
		"size":    info.Size(),
	})
}
