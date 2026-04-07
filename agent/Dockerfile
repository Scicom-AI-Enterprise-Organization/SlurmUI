FROM golang:1.22-alpine AS builder

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags "-s -w" \
    -o aura-agent ./cmd/aura-agent

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=builder /build/aura-agent /usr/local/bin/aura-agent
ENTRYPOINT ["/usr/local/bin/aura-agent"]
