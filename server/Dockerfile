# Build from the repo root:  docker build -f server/Dockerfile -t snag .
# Produces one static binary plus widget.min.js on a distroless base (~21 MB).

FROM node:24-alpine AS widget
WORKDIR /w
COPY widget/package.json widget/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY widget/ ./
RUN npm run build

FROM golang:1.26-alpine AS server
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /snag ./cmd/snag

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /snag /snag
COPY --from=widget /w/dist/widget.min.js /srv/widget.min.js
ENV SNAG_ADDR=:8080 SNAG_WIDGET_FILE=/srv/widget.min.js
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/snag"]
