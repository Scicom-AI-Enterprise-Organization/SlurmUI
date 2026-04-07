BINARY_NAME := aura-agent
VERSION := 0.1.0
GOOS := linux
GOARCH := amd64

.PHONY: build build-local test lint clean docker

build:
	GOOS=$(GOOS) GOARCH=$(GOARCH) go build \
		-ldflags "-s -w -X main.Version=$(VERSION)" \
		-o bin/$(BINARY_NAME) ./cmd/aura-agent

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
