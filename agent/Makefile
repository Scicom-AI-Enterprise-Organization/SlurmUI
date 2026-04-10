BINARY_NAME := aura-agent
VERSION := 0.1.0
GOOS := linux
# Default to host arch so Docker Desktop (Apple Silicon) gets the right binary.
# Override for production: make build GOARCH=amd64
GOARCH ?= $(shell go env GOARCH)

.PHONY: build build-amd64 build-arm64 build-local test lint clean docker

build:
	GOOS=$(GOOS) GOARCH=$(GOARCH) go build \
		-ldflags "-s -w -X main.Version=$(VERSION)" \
		-o bin/$(BINARY_NAME) ./cmd/aura-agent

# Explicit targets for cross-compilation
build-amd64:
	GOOS=linux GOARCH=amd64 go build \
		-ldflags "-s -w -X main.Version=$(VERSION)" \
		-o bin/$(BINARY_NAME)-amd64 ./cmd/aura-agent

build-arm64:
	GOOS=linux GOARCH=arm64 go build \
		-ldflags "-s -w -X main.Version=$(VERSION)" \
		-o bin/$(BINARY_NAME)-arm64 ./cmd/aura-agent

build-local:
	go build \
		-ldflags "-s -w -X main.Version=$(VERSION)" \
		-o bin/$(BINARY_NAME) ./cmd/aura-agent

test:
	go test -v -race ./...

lint:
	go vet ./...

clean:
	rm -rf bin/

docker:
	docker build -t aura-agent:$(VERSION) .
