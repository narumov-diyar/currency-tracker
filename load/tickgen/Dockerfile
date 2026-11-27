FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY load/tickgen/main.go ./load/tickgen/
RUN CGO_ENABLED=0 go build -trimpath -o /out/tickgen ./load/tickgen

FROM alpine:3.21
COPY --from=build /out/tickgen /usr/local/bin/tickgen
USER 10001
ENTRYPOINT ["tickgen"]
