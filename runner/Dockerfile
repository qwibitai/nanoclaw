# syntax=docker/dockerfile:1
FROM golang:1.21-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /nanoclaw-runner ./cmd/nanoclaw-runner

FROM alpine:3.19
COPY --from=build /nanoclaw-runner /usr/local/bin/nanoclaw-runner
ENTRYPOINT ["nanoclaw-runner"]
