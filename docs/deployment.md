# HoV Router Deployment Documentation

## Overview

HoV Router (formerly better-ccflare) is a load balancer proxy for Claude API accounts that can be deployed in various configurations, from simple local development to production-grade distributed systems. This document covers all deployment options, from single-instance setups to scalable architectures.

> **Important**: HoV Router provides a powerful CLI interface and web dashboard for monitoring and management. The primary command is `hov-router` (older command names such as `better-ccflare` also work); the executable provides all functionality through command-line flags.

## Table of Contents

1. [Deployment Options Overview](#deployment-options-overview)
2. [Local Development Setup](#local-development-setup)
3. [Production Deployment](#production-deployment)
   - [System Requirements](#system-requirements)
   - [Bun Binary Compilation](#bun-binary-compilation)
   - [Process Management](#process-management)
4. [Docker Deployment](#docker-deployment)
5. [Cloudflare Pages (Dashboard Only)](#cloudflare-pages-dashboard-only)
6. [Reverse Proxy Setup](#reverse-proxy-setup)
7. [Monitoring and Logging](#monitoring-and-logging)
8. [Performance Tuning](#performance-tuning)
9. [Scaling Considerations](#scaling-considerations)
10. [Environment Variables Reference](#environment-variables-reference)

## Deployment Options Overview

```mermaid
graph TB
    subgraph "Deployment Options"
        DEV[Local Development<br/>bun start]
        BINARY[Compiled Binary<br/>Single executable]
        DOCKER[Docker Container<br/>Containerized deployment]
        PM2[PM2 Process<br/>Node process manager]
        SYSTEMD[Systemd Service<br/>Linux service]
        K8S[Kubernetes<br/>Container orchestration]
    end
    
    subgraph "Frontend Options"
        EMBEDDED[Embedded Dashboard<br/>Served by server]
        CF_PAGES[Cloudflare Pages<br/>Static hosting]
        NGINX_STATIC[Nginx Static<br/>Separate frontend]
    end
    
    DEV --> EMBEDDED
    BINARY --> EMBEDDED
    BINARY --> CF_PAGES
    DOCKER --> EMBEDDED
    PM2 --> EMBEDDED
    SYSTEMD --> EMBEDDED
    K8S --> CF_PAGES
    K8S --> NGINX_STATIC
```

## Local Development Setup

### Prerequisites

- Bun runtime (>= 1.2.8)
- SQLite (included with Bun - no external database setup required)
- Git
- Node.js compatible system (Linux, macOS, Windows)

### Quick Start

```bash
# Clone the repository
git clone https://github.com/StartupBros/hov-router.git
cd hov-router

# Install dependencies
bun install

# Build the project (dashboard and CLI)
bun run build

# Start HoV Router (Server + Dashboard)
bun run better-ccflare

# Or use CLI commands:
bun run cli --serve

# Server with hot-reload (development)
bun run dev:server

# In another terminal, add Claude accounts
bun run cli --add-account myaccount --mode max --priority 0
```

### Development Configuration

```bash
# Environment variables for development
export PORT=8080
export LB_STRATEGY=session  # session (default), least-used, session-affinity, or session-drain-soonest (opt-in)
export LOG_LEVEL=DEBUG
export LOG_FORMAT=pretty  # Options: pretty, json

# Start with custom config
bun run better-ccflare
```

## Production Deployment

### System Requirements

#### Minimum Requirements
- CPU: 2 cores
- RAM: 2GB
- Storage: 10GB (for logs and database)
- OS: Linux (Ubuntu 20.04+, Debian 11+), macOS, Windows Server 2019+

#### Recommended Requirements
- CPU: 4+ cores
- RAM: 4GB+
- Storage: 50GB+ SSD
- Network: Low-latency connection to Claude API

### Bun Binary Compilation

Compile HoV Router into a single executable for easy deployment:

```bash
# Build all components (dashboard and CLI)
bun run build

# Build the main HoV Router binary (includes CLI and server)
cd apps/cli
bun build src/main.ts --compile --outfile dist/better-ccflare --target=bun

# Copy binary to deployment location
cp apps/cli/dist/better-ccflare /opt/better-ccflare/
# Make it executable
chmod +x /opt/better-ccflare/better-ccflare
```

#### Binary Deployment Structure

```
/opt/better-ccflare/
├── better-ccflare             # Main binary (CLI + Server)
├── config/
│   └── config.json     # Configuration (optional)
└── data/
    ├── better-ccflare.db      # SQLite database
    └── logs/           # Log files (if configured)
```

**Note**: The configuration and database are automatically created in platform-specific directories:
- **Linux/macOS**: `~/.config/better-ccflare/`
- **Windows**: `%LOCALAPPDATA%\better-ccflare\` or `%APPDATA%\better-ccflare\`

### Process Management

#### PM2 Setup

```bash
# Install PM2 globally
npm install -g pm2

# Create ecosystem file
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'better-ccflare',
    script: '/opt/better-ccflare/better-ccflare',
    args: '--serve',
    instances: 1,
    exec_mode: 'fork',
    env: {
      PORT: 8080,
      LB_STRATEGY: 'session',
      LOG_LEVEL: 'INFO',
      LOG_FORMAT: 'json',
      CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      SESSION_DURATION_MS: 18000000,
      RETRY_ATTEMPTS: 3,
      RETRY_DELAY_MS: 1000,
      RETRY_BACKOFF: 2
    },
    error_file: '/opt/better-ccflare/data/logs/error.log',
    out_file: '/opt/better-ccflare/data/logs/out.log',
    log_file: '/opt/better-ccflare/data/logs/combined.log',
    time: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    watch: false
  }]
};
EOF

# Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

#### Systemd Service

Create a systemd service file:

```bash
# Create service file
sudo cat > /etc/systemd/system/better-ccflare.service << 'EOF'
[Unit]
Description=HoV Router Load Balancer
After=network.target

StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=better-ccflare
Group=better-ccflare
WorkingDirectory=/opt/better-ccflare
ExecStart=/opt/better-ccflare/better-ccflare --serve
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=143

# Environment
Environment="PORT=8080"
Environment="LB_STRATEGY=session"
Environment="LOG_LEVEL=INFO"
Environment="LOG_FORMAT=json"
Environment="CLIENT_ID=9d1c250a-e61b-44d9-88ed-5944d1962f5e"
Environment="SESSION_DURATION_MS=18000000"
Environment="RETRY_ATTEMPTS=3"
Environment="RETRY_DELAY_MS=1000"
Environment="RETRY_BACKOFF=2"

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/better-ccflare/data

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096

[Install]
WantedBy=multi-user.target
EOF

When this unit is backed by `scripts/run-ccflare-stack.sh`, unexpected child
failures use the runner's bounded aggregate cleanup setting
`RUNNER_FAILURE_STOP_BUDGET_MS` (30,000 ms by default; hard maximum 120,000 ms).
It is failure-only: an operator `TERM`/`INT` still receives the full guard
shutdown grace and cushion so active requests can drain. Keep the failure
budget below the unit's `StartLimitIntervalSec` window and verify the runner's
startup log reports both budgets after changing the environment.

# Create user and directories
sudo useradd -r -s /bin/false better-ccflare
sudo mkdir -p /opt/better-ccflare/{config,data/logs}
sudo chown -R better-ccflare:better-ccflare /opt/better-ccflare

# Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable better-ccflare
sudo systemctl start better-ccflare
```

## Docker Deployment

The repository ships a `Dockerfile` and `docker-compose.yml` that build HoV Router from source. No prebuilt image is published.

```bash
docker compose up -d --build
```

See [Run HoV Router in Docker](docker.md) for plain `docker run`, the data volume and backups, environment variables, health and provenance, and upgrades.

## Cloudflare Pages (Dashboard Only)

Deploy the dashboard as a static site on Cloudflare Pages while running the API server elsewhere:

### Build Configuration

```bash
# Build script for Cloudflare Pages
cd packages/dashboard-web
bun install
bun run build

# Output directory: packages/dashboard-web/dist
```

### Cloudflare Pages Configuration

1. Connect your GitHub repository
2. Set build configuration:
   - Build command: `cd packages/dashboard-web && bun install && bun run build`
   - Build output directory: `packages/dashboard-web/dist`
   - Root directory: `/`

### Environment Variables

```bash
# Set in Cloudflare Pages dashboard
VITE_API_URL=https://api.your-domain.com
```

### Dashboard API Configuration

Update the dashboard to use external API:

```typescript
// packages/dashboard-web/src/lib/api-client.ts
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
```

## Reverse Proxy Setup

### Nginx Configuration

```nginx
# /etc/nginx/sites-available/better-ccflare
upstream better-ccflare_backend {
    server 127.0.0.1:8080 max_fails=3 fail_timeout=30s;
    keepalive 32;
}

server {
    listen 80;
    server_name better-ccflare.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name better-ccflare.yourdomain.com;

    # SSL configuration
    ssl_certificate /etc/letsencrypt/live/better-ccflare.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/better-ccflare.yourdomain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Proxy settings
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # Timeouts
    proxy_connect_timeout 60s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;

    # Main proxy
    location / {
        proxy_pass http://better-ccflare_backend;
    }

    # API endpoints
    location /v1/ {
        proxy_pass http://better-ccflare_backend;
        
        # Increase limits for AI requests
        client_max_body_size 100M;
        proxy_buffering off;
        proxy_request_buffering off;
    }

    # WebSocket support for real-time updates
    location /ws {
        proxy_pass http://better-ccflare_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }

    # Static assets caching
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        proxy_pass http://better-ccflare_backend;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

### Caddy Configuration

```caddyfile
better-ccflare.yourdomain.com {
    # Automatic HTTPS
    tls your-email@example.com

    # Reverse proxy
    reverse_proxy localhost:8080 {
        # Load balancing if multiple instances
        lb_policy least_conn
        lb_try_duration 30s
        
        # Headers
        header_up Host {host}
        header_up X-Real-IP {remote}
        header_up X-Forwarded-For {remote}
        header_up X-Forwarded-Proto {scheme}
        
        # Health check
        health_uri /health
        health_interval 30s
        health_timeout 5s
    }

    # API specific configuration
    handle_path /v1/* {
        reverse_proxy localhost:8080 {
            # Streaming support
            flush_interval -1
            buffer_requests off
            buffer_responses off
            
            # Timeouts
            transport http {
                read_timeout 5m
                write_timeout 5m
            }
        }
    }

    # Compression
    encode gzip

    # Security headers
    header {
        X-Frame-Options SAMEORIGIN
        X-Content-Type-Options nosniff
        X-XSS-Protection "1; mode=block"
        Referrer-Policy strict-origin-when-cross-origin
    }
}
```

## Monitoring and Logging

### Log Management

```mermaid
graph TB
    subgraph "Logging Architecture"
        APP[HoV Router Server]
        
        subgraph "Log Outputs"
            FILE[File Logs<br/>/var/log/better-ccflare/]
            STDOUT[Container Stdout]
            SYSLOG[Syslog]
        end
        
        subgraph "Log Aggregation"
            LOKI[Loki]
            ELK[ELK Stack]
            CLOUDWATCH[CloudWatch]
        end
        
        subgraph "Visualization"
            GRAFANA[Grafana]
            KIBANA[Kibana]
        end
    end
    
    APP --> FILE
    APP --> STDOUT
    APP --> SYSLOG
    
    FILE --> LOKI
    STDOUT --> ELK
    SYSLOG --> CLOUDWATCH
    
    LOKI --> GRAFANA
    ELK --> KIBANA
    CLOUDWATCH --> GRAFANA
```

### Prometheus Metrics (Future Enhancement)

> **Note**: Prometheus metrics support is planned but not yet implemented. The following is an example of how metrics could be integrated:

```typescript
// Example: packages/http-api/src/metrics.ts
import { register, Counter, Histogram, Gauge } from 'prom-client';

export const metrics = {
  requestsTotal: new Counter({
    name: 'better-ccflare_requests_total',
    help: 'Total number of requests',
    labelNames: ['method', 'status', 'account']
  }),
  
  requestDuration: new Histogram({
    name: 'better-ccflare_request_duration_seconds',
    help: 'Request duration in seconds',
    labelNames: ['method', 'status'],
    buckets: [0.1, 0.5, 1, 2, 5, 10]
  }),
  
  activeAccounts: new Gauge({
    name: 'better-ccflare_active_accounts',
    help: 'Number of active accounts',
    labelNames: ['priority']
  }),
  
  rateLimitedAccounts: new Gauge({
    name: 'better-ccflare_rate_limited_accounts',
    help: 'Number of rate limited accounts'
  })
};
```

### Monitoring Stack

```yaml
# docker-compose.monitoring.yml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana:latest
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_INSTALL_PLUGINS=grafana-clock-panel
    volumes:
      - grafana_data:/var/lib/grafana
      - ./grafana/dashboards:/etc/grafana/provisioning/dashboards
      - ./grafana/datasources:/etc/grafana/provisioning/datasources
    ports:
      - "3000:3000"

  loki:
    image: grafana/loki:latest
    volumes:
      - ./loki-config.yaml:/etc/loki/local-config.yaml
      - loki_data:/loki
    ports:
      - "3100:3100"

  promtail:
    image: grafana/promtail:latest
    volumes:
      - ./promtail-config.yaml:/etc/promtail/config.yml
      - /var/log:/var/log:ro
      - /opt/better-ccflare/data/logs:/app/logs:ro
    command: -config.file=/etc/promtail/config.yml

volumes:
  prometheus_data:
  grafana_data:
  loki_data:
```

## Performance Tuning

### System Optimization

```bash
# Increase file descriptor limits
echo "better-ccflare soft nofile 65536" >> /etc/security/limits.conf
echo "better-ccflare hard nofile 65536" >> /etc/security/limits.conf

# TCP tuning for high throughput
cat >> /etc/sysctl.conf << EOF
# TCP tuning
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_keepalive_intvl = 15

# Buffer sizes
net.core.rmem_default = 262144
net.core.wmem_default = 262144
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
EOF

# Apply changes
sysctl -p
```

### Application Tuning

```json
// ~/.config/better-ccflare/config.json (or platform-specific location)
{
  "lb_strategy": "session",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "session_duration_ms": 18000000,  // 5 hours
  "port": 8080
}
```

**Note**: These settings can also be configured via environment variables, which take precedence over the config file.
```

### Database Optimization

```sql
-- Optimize SQLite for production
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -20000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
CREATE INDEX IF NOT EXISTS idx_requests_account ON requests(account_used);
CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(paused, expires_at);
```

## Scaling Considerations

### Horizontal Scaling Architecture

```mermaid
graph TB
    subgraph "Load Balancer Layer"
        LB[HAProxy/Nginx<br/>Load Balancer]
    end
    
    subgraph "Application Instances"
        APP1[better-ccflare-1<br/>Port 8081]
        APP2[better-ccflare-2<br/>Port 8082]
        APP3[better-ccflare-N<br/>Port 808N]
    end
    
    subgraph "Shared Data Layer"
        REDIS[(Redis<br/>Session Store)]
        PG[(PostgreSQL<br/>Main Database)]
        S3[S3-Compatible<br/>Object Storage]
    end
    
    subgraph "Service Discovery"
        CONSUL[Consul/etcd]
    end
    
    LB --> APP1
    LB --> APP2
    LB --> APP3
    
    APP1 --> REDIS
    APP1 --> PG
    APP1 --> S3
    APP1 --> CONSUL
    
    APP2 --> REDIS
    APP2 --> PG
    APP2 --> S3
    APP2 --> CONSUL
    
    APP3 --> REDIS
    APP3 --> PG
    APP3 --> S3
    APP3 --> CONSUL
```

### Database Considerations

HoV Router uses SQLite by default, which is suitable for single-instance deployments. For Kubernetes deployments where the pod's local disk isn't durable across restarts, set `DATABASE_URL` to use PostgreSQL instead (see [PostgreSQL Support for Kubernetes Deployments](#postgresql-support-for-kubernetes-deployments) above). This does not permit running multiple replicas — see [Multi-Instance Deployment](#multi-instance-deployment-single-instance-per-database) below.

#### SQLite Optimization (Default)

```sql
-- These optimizations are automatically applied by HoV Router
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -20000;  -- 20MB cache
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
```

### PostgreSQL Support for Kubernetes Deployments

SQLite is unsuitable for Kubernetes deployments because a pod's local disk is not guaranteed to survive a restart or reschedule. HoV Router has first-class PostgreSQL support via `Bun.SQL` — set the `DATABASE_URL` environment variable and the schema is created automatically on startup. Note this solves *durability*, not *concurrency*: HoV Router is still [single-instance-per-database](#multi-instance-deployment-single-instance-per-database), so this is for a single pod (`replicas: 1`), not a multi-pod fleet sharing one database.

```bash
# Create a PostgreSQL database
psql -U postgres -c "CREATE DATABASE ccflare;"
psql -U postgres -c "CREATE USER ccflare_user WITH PASSWORD 'secret';"
psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE ccflare TO ccflare_user;"

# Set DATABASE_URL — that's all that's needed
export DATABASE_URL=postgresql://ccflare_user:secret@postgres-host:5432/ccflare
```

The full schema (`accounts`, `requests`, `request_payloads`, `oauth_sessions`, `agent_preferences`, `api_keys`, `model_translations`, `strategies`) is created with `CREATE TABLE IF NOT EXISTS` on first start. Column migrations use `information_schema` checks and are applied automatically on every startup.

### Kubernetes Deployment

> **Important**: HoV Router is [single-instance-per-database](#multi-instance-deployment-single-instance-per-database) — run exactly **one** replica per `DATABASE_URL`. Use PostgreSQL (not SQLite) so the pod's state survives a restart or reschedule, but do not scale this deployment horizontally; two pods sharing one database will silently diverge (as of [PR #376](https://github.com/tombii/better-ccflare/pull/376), the startup guard will warn — but not refuse by default — when this happens). To scale, run separate `DATABASE_URL`-per-deployment stacks with disjoint account sets (see [Multi-Instance Deployment](#multi-instance-deployment-single-instance-per-database)).

```yaml
# better-ccflare-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: better-ccflare
  labels:
    app: better-ccflare
spec:
  replicas: 1 # single-instance-per-database — do not scale this without a separate DATABASE_URL
  selector:
    matchLabels:
      app: better-ccflare
  template:
    metadata:
      labels:
        app: better-ccflare
    spec:
      containers:
      - name: better-ccflare
        image: your-registry/better-ccflare:latest
        ports:
        - containerPort: 8080
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: better-ccflare-secrets
              key: database-url
        - name: LB_STRATEGY
          value: "session"
        - name: LOG_LEVEL
          value: "INFO"
        - name: LOG_FORMAT
          value: "json"
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: better-ccflare
spec:
  selector:
    app: better-ccflare
  ports:
  - port: 80
    targetPort: 8080
  type: LoadBalancer
---
# Store the PostgreSQL connection string as a Secret
apiVersion: v1
kind: Secret
metadata:
  name: better-ccflare-secrets
type: Opaque
stringData:
  database-url: "postgresql://ccflare_user:secret@postgres-svc:5432/ccflare"
```

### High Availability Checklist

- [ ] Database replication configured
- [ ] Redis sentinel or cluster mode enabled
- [ ] Load balancer health checks configured
- [ ] Automatic failover tested
- [ ] Backup and restore procedures documented
- [ ] Monitoring alerts configured
- [ ] Disaster recovery plan in place
- [ ] Performance baselines established
- [ ] Security audit completed
- [ ] Documentation up to date

## Multi-Instance Deployment: Single-Instance-per-Database

> **Operator rule (read first):** HoV Router is **single-instance-per-database**. Run exactly one process per database. Running two or more instances against the same database is unsupported and will silently diverge.

This is the most important sentence in the deployment guide. The rest of this section explains why, what diverges, and what the operator should do instead.

### What this rule means

A second instance sharing the same database is not a "high availability" setup — it is a hidden divergent state. The database is shared, but the seven categories of in-process coordination state below are not. They diverge silently: each instance sees consistent durable state and inconsistent transient state, so nothing errors. Routing decisions, rate-limit handling, and OAuth refreshes simply start to disagree across instances.

### What diverges when two instances share a database

In operator terms, the seven categories of in-process coordination state are:

- **Sticky client-to-account routing.** A client talking to instance A can be routed to a different account than the same client talking to instance B. The same conversation can hop between accounts mid-flight.
- **Account recency penalty.** Recently-used accounts are penalised to spread load. Two instances independently keep this recency map, so they can both pick the same "fresh" account, or both penalise the same account.
- **In-memory usage cache.** Used to make rate-limit decisions. Two instances have two views of the same account's recent usage. Each instance may decide the account has headroom when the other has seen it exhausted.
- **Keepalive body replay cache.** Cached upstream responses can be replayed by one instance and missed by another, leading to duplicate upstream requests or missed replay-style fast paths.
- **OAuth refresh scheduler.** A second instance refreshes the same OAuth token concurrently. This is a **race against the upstream provider**, not just a duplicate request — concurrent refreshes can invalidate the token the other instance is about to use.
- **Rate-limit recovery probe lease map.** A single-flight probe map prevents two probes from running at once on the same account. Two instances each run their own probe map, so the recovery probe can run twice in parallel.
- **Session-volume circuit breaker.** A circuit breaker that opens on session overage fires per-instance. Sessions can be ended earlier or later than expected depending on which instance handles them.

### Why it is silent

There is no error. Each instance sees the same database and the same set of accounts. There is no coordination layer (no Redis, no leader election, no distributed lock) that would let an instance know the other has fresher in-process state. The divergence is a property of the design, not a bug in the steady-state.

### What to do instead

- **Run one instance per database.** This is the standard, supported, and only safe configuration.
- **For zero-downtime deploys, use a cold handoff (rolling restart), not blue/green.** Because the rule above forbids two live instances against one database, true blue/green — run both and cut over — is not achievable here. The supported pattern is: stop instance A, wait for it to exit, then start instance B. There is a brief unavailability window while instance B starts and becomes ready (typically a few seconds for process startup). Eliminating that window entirely would require either a second database or an external coordination layer (leader election or advisory lock) — the project provides neither. The managed stack's [backend-only deployment](#retained-ingress-backend-transactions) shortens the window without breaking this rule. Its quiesced old process stays connected to the database only to finish requests it had already accepted. It holds no listener, runs no schedulers and refreshes no tokens, while exactly one process admits new work.
- **For horizontal scaling, scale the accounts, not the instances — and only with one database per instance.** Each instance must own its own database holding its own disjoint account subset, and the client (or upstream load balancer) routes to the instance owning the account it needs. This partitioning is an operator-maintained convention: the product does not enforce it. If two instances share one database, every instance loads the full account set and selects server-side, so the partition is imaginary and all seven divergence categories above remain reachable.

## Security Considerations

### Production Security Checklist

1. **Network Security**
   - [ ] Firewall rules configured
   - [ ] SSL/TLS certificates installed
   - [ ] Rate limiting configured
   - [ ] DDoS protection enabled

2. **Application Security**
   - [ ] Authentication implemented for admin endpoints
   - [ ] API keys properly secured
   - [ ] Input validation enabled
   - [ ] Security headers configured

3. **Data Security**
   - [ ] Database encryption at rest
   - [ ] Backup encryption enabled
   - [ ] Access logs configured
   - [ ] Audit trail implemented

4. **Operational Security**
   - [ ] Least privilege user accounts
   - [ ] Regular security updates
   - [ ] Intrusion detection configured
   - [ ] Incident response plan

## Health Monitoring

### Health Check Endpoint

HoV Router provides a health check endpoint for monitoring:

```bash
# Check health status
curl http://localhost:8080/health
```

Response format:
```json
{
  "status": "ok",
  "accounts": 5,
  "timestamp": "2025-01-27T12:00:00.000Z",
  "strategy": "session",
  "pool": {
    "configured": 5,
    "routable": 3,
    "paused": 1,
    "rate_limited": 1,
    "next_available_at": null
  }
}
```

**HTTP status codes:** `200` for `ok`, `503` for `degraded` or `unhealthy`. Infrastructure health checkers (Kubernetes readiness probes, load balancers) gate on the HTTP status code automatically.

**Status values:**
- `ok` — runtime healthy and at least one account is routable
- `degraded` — pool empty but accounts will recover (`next_available_at` set); k8s readiness probe marks pod NotReady until recovery
- `unhealthy` — runtime broken or no recovery possible

**Per-account detail (opt-in):** Set `HEALTH_DETAIL_ENABLED=true` to enable `GET /health?detail=1`, which returns per-account status and rate-limit timestamps. Disabled by default to prevent unauthenticated account enumeration.

### Monitoring Integration

Use the health endpoint with monitoring tools:

```yaml
# Kubernetes readiness probe — marks pod NotReady when degraded/unhealthy (503)
readinessProbe:
  httpGet:
    path: /health
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 30

# Kubernetes liveness probe
livenessProbe:
  httpGet:
    path: /health
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 30

# Docker Compose health check  
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
  interval: 30s
  timeout: 10s
  retries: 3
```

## API Endpoints Reference

### Management API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check and system status |
| `/api/stats` | GET | Account statistics and usage |
| `/api/stats/reset` | POST | Reset usage statistics |
| `/api/requests` | GET | Request history with pagination |
| `/api/accounts` | GET | List all accounts |
| `/api/accounts/:name` | GET | Get specific account details |
| `/api/accounts/:name` | PATCH | Update account (pause/unpause) |
| `/api/accounts/:name` | DELETE | Remove account |
| `/api/config` | GET | Get current configuration |
| `/api/config` | PATCH | Update configuration |

### Analytics API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/analytics/usage` | GET | Usage analytics with filtering |
| `/api/analytics/costs` | GET | Cost breakdown by model/account |
| `/api/analytics/requests/:id` | GET | Request details with payload |

### Real-time API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/logs/stream` | GET | Real-time log streaming (SSE) |
| `/api/logs/history` | GET | Historical logs (paginated) |

### Claude API Proxy

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/*` | * | All Claude API endpoints |

## Troubleshooting

### Common Issues

1. **Database Lock Errors**
   ```bash
   # Find the actual database location
   # Linux/macOS:
   sqlite3 ~/.config/better-ccflare/better-ccflare.db "PRAGMA journal_mode=WAL;"
   
   # Windows:
   sqlite3 %LOCALAPPDATA%\better-ccflare\better-ccflare.db "PRAGMA journal_mode=WAL;"
   ```

2. **High Memory Usage**
   ```bash
   # Check for memory leaks
   node --inspect=0.0.0.0:9229 /opt/better-ccflare/better-ccflare-server
   ```

3. **Connection Refused**
   ```bash
   # Check if service is running
   systemctl status better-ccflare
   # Check logs
   journalctl -u better-ccflare -f
   ```

4. **Rate Limit Issues**
   ```bash
   # Check account status
   hov-router --list
   # Reset statistics
   hov-router --reset-stats
   ```

## Maintenance

### Regular Tasks

```bash
# Daily: Check recent errors (systemd install; use your unit's name)
journalctl -u better-ccflare --since "24 hours ago" | grep ERROR

# Weekly: Database maintenance
# Linux/macOS:
sqlite3 ~/.config/better-ccflare/better-ccflare.db "VACUUM;"
sqlite3 ~/.config/better-ccflare/better-ccflare.db "ANALYZE;"

# Monthly: Clean old request history
hov-router --clear-history

# Quarterly: Update dependencies (if running from source)
cd /path/to/hov-router
bun update
```

### Backup Procedures

```bash
#!/bin/bash
# backup.sh - Run daily via cron

BACKUP_DIR="/backup/better-ccflare/$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"

# Determine config directory based on OS
if [[ "$OSTYPE" == "darwin"* ]] || [[ "$OSTYPE" == "linux-gnu"* ]]; then
    CONFIG_DIR="$HOME/.config/better-ccflare"
elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
    CONFIG_DIR="$LOCALAPPDATA/better-ccflare"
else
    CONFIG_DIR="$HOME/.config/better-ccflare"  # Default fallback
fi

# Back up the database with VACUUM INTO, not the sqlite3 `.backup` command.
# The server writes continuously, and SQLite restarts an online `.backup`
# whenever another connection writes to the source, so on a busy database it
# may never finish. VACUUM INTO writes one consistent snapshot in a single
# read transaction, including changes still in the -wal file. Its target must
# not already exist, and an interrupted run can leave a partial file, so write
# to a temporary name and rename only on success.
SNAPSHOT="$BACKUP_DIR/better-ccflare.db"
if ! sqlite3 "$CONFIG_DIR/better-ccflare.db" ".timeout 30000" "VACUUM INTO '$SNAPSHOT.partial'"; then
    rm -f "$SNAPSHOT.partial"
    exit 1
fi
mv "$SNAPSHOT.partial" "$SNAPSHOT"
cp "$CONFIG_DIR/config.json" "$BACKUP_DIR/" 2>/dev/null || true

# Compress
tar -czf "$BACKUP_DIR.tar.gz" "$BACKUP_DIR"
rm -rf "$BACKUP_DIR"

# Keep only last 30 days
find /backup/better-ccflare -name "*.tar.gz" -mtime +30 -delete
```

## Environment Variables Reference

### Core Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | Server port |
| `LB_STRATEGY` | session | Load balancing strategy: `session`, `least-used`, `session-affinity`, or opt-in `session-drain-soonest`. Session-based strategies preserve OAuth stickiness; `least-used` spreads requests by utilization. |
| `LOG_LEVEL` | INFO | Logging level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `LOG_FORMAT` | pretty | Log format: `pretty` (human-readable) or `json` (structured) |
| `BETTER_CCFLARE_DEBUG` | 0 | Enable debug mode (1/0) - enables console output |

### Advanced Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CLIENT_ID` | 9d1c250a-e61b-44d9-88ed-5944d1962f5e | OAuth client ID for authentication |
| `SESSION_DURATION_MS` | 18000000 | Session duration in milliseconds (5 hours) |
| `RETRY_ATTEMPTS` | 3 | Number of retry attempts for failed requests |
| `RETRY_DELAY_MS` | 1000 | Initial delay between retries in milliseconds |
| `RETRY_BACKOFF` | 2 | Backoff multiplier for exponential retry delays |
| `BETTER_CCFLARE_CONFIG_PATH` | Platform-specific | Path to configuration file |
| `BETTER_CCFLARE_DB_PATH` | Platform-specific | Path to SQLite database file (ignored when `DATABASE_URL` is set) |
| `DATABASE_URL` | - | PostgreSQL connection string. When set, PostgreSQL is used instead of SQLite. Recommended for single-pod Kubernetes deployments (durable state across restarts). Each better-ccflare instance requires its own database — see [Multi-Instance Deployment](#multi-instance-deployment-single-instance-per-database). Example: `postgresql://user:pass@host:5432/db` |

### Configuration File

HoV Router also supports a JSON configuration file that takes precedence over environment variables:

```json
{
  "lb_strategy": "session",
  "client_id": "your-client-id",
  "retry_attempts": 5,
  "retry_delay_ms": 2000,
  "retry_backoff": 1.5,
  "session_duration_ms": 7200000,
  "port": 3000
}
```

The configuration file is located at:
- **Linux/macOS**: `~/.config/better-ccflare/config.json`
- **Windows**: `%APPDATA%\better-ccflare\config.json`

## Conclusion

HoV Router is designed to be flexible and scalable, supporting everything from simple local deployments to complex distributed architectures. Choose the deployment option that best fits your needs and scale as your requirements grow.

### Key Features Summary

- **Integrated Binary**: Single executable combining CLI and server functionality
- **Web Dashboard**: Access analytics and logs through a modern web interface
- **Async Database Writer**: Improved performance for high-throughput scenarios
- **Four Load-Balancing Strategies**: Choose account-level sessions, per-client affinity, utilization-based spreading, or the opt-in drain-soonest ordering
- **Binary Compilation**: Deploy as standalone executable without runtime dependencies

### Additional Resources

- [Main Documentation](./index.md)
- [Configuration Guide](./configuration.md)
- [Load Balancing Strategies](./load-balancing.md)
- [API Reference](./api-http.md)
- [GitHub Repository](https://github.com/StartupBros/hov-router)

## Web Dashboard

HoV Router includes a powerful web-based dashboard for monitoring and management.

### Accessing the Dashboard

```bash
# Start HoV Router server with embedded dashboard
hov-router --serve

# Or from source:
bun run better-ccflare

# Dashboard will be available at:
# http://localhost:8080 (or your configured port)
```

### Dashboard Features

- **Real-time Metrics**: Live system status and request analytics
- **Account Management**: View and manage Claude accounts
  - Account status and rate limits
  - Pause/unpause accounts
  - View usage statistics
  - Re-authenticate accounts
- **Request History**: Track requests with detailed information
  - Request details and timing
  - Success/failure status
  - Token usage per request
- **Analytics**: Comprehensive analytics and visualizations
  - Usage patterns over time
  - Cost breakdown
  - Performance metrics
  - Account distribution

### Remote API Connection

The HoV Router CLI can connect to a remote API server for distributed deployments:

```bash
# Set API URL for remote connection
export BETTER_CCFLARE_API_URL=https://better-ccflare.example.com
hov-router --list  # Will query the remote server
```

For support and updates, check the project repository and documentation.

### Retained-ingress backend transactions

The managed Linux stack has two different lifecycle operations. A terminal service shutdown closes the public listener and drains existing requests. A compatible backend-only deployment keeps that listener and its Node guard running, fences new backend dispatch, and queues a bounded number of unread requests while replacing the single Bun database/routing owner. It preserves admission, not continuous dispatch or completion. Queue expiry and forced old-stream retirement remain possible and are reported separately.

When the running backend's `/health` advertises `handoff: {"protocol": "quiesce-v1", "pid": <its pid>}`, the deployment overlaps the old backend instead of draining it first:

1. The guard fences the old generation, which holds new admission and starts that generation's retire timer (`GUARD_SHUTDOWN_GRACE_MS`, 600 s by default). Fencing also discards pooled upstream connections, so no keep-alive socket to the old backend can carry later traffic.
2. The runner sends `SIGUSR2`. The old backend stops its schedulers and usage polls, stops refreshing OAuth tokens (it may still adopt fresher tokens from the database), deletes its heartbeat row, and releases the backend port without cutting in-flight responses.
3. The transaction records `quiescing`, then `old_quiesced` only once nothing listens on the port over IPv4 or IPv6. The candidate then boots on the same port and is verified, committed and attached as below, so queued and new requests wait for the candidate's boot rather than for old streams.
4. After attach, a background reaper waits for the guard to retire the old generation, when its last request ends or the retire timer aborts it. The reaper then stops the old process by PID and start time. `/_guard/health` shows the pending retirement as `lifecycle.retiring` (generation and dispatched count) and the result as `lifecycle.lastRetireOutcome`.

A retiring request that would need a guard retry after the fence gets a 503 instead, because the port now belongs to the replacement. A backend that does not advertise the capability (Bun exits on an unhandled `SIGUSR2`), or that still listens after `RUNNER_QUIESCE_PORT_TIMEOUT_MS` (default 10000, range 100-120000), takes the drain path described below. A deployment that arrives while the previous handoff's backend is still retiring waits for it first, for up to the retire timer plus the backend stop allowance. Run one deployment at a time: if `lifecycle.retiring` is not `null`, that wait plus a drain fallback can outlast the deployment script's 800-second verification window.

The official deployment script selects backend-only handoff only when the running runner, guard, recovery policy, timing module and transaction module have exactly the same bytes as the candidate artifacts, and the SQLite/PostgreSQL migration-source digest is unchanged. Lifecycle changes and schema changes take the existing full-stack bootstrap path. The first deployment introducing this protocol therefore still requires a measured full restart. No database-sharing blue/green instance is started.

The runner records a private, fsynced intent with a transaction ID, old generation and PID/start identity, exact prior pin hash, immutable candidate binary hash/source, candidate nonce and compatibility digest. It authenticates a permissioned local control command. On the drain path it records draining, fences dispatch, then reaps the old PID/start before starting the candidate. While draining, the guard still sends dashboard reads (GET or HEAD outside `/v1/`, excluding paths ending in `/stream`) to the old backend; they join its generation, so the drain waits for them. Guard verification checks the executable, listener ownership, source, nonce, generation, readiness and timing contract. The candidate remains fenced until the exact systemd pin and committed phase are durable. Attach rotates the per-generation credential before releasing queued requests. Health reports the retained ingress source separately from `backendSourceSha`.

An incompatible manifest, stale command, ambiguous owner, changed pin, or unfinished transaction holds dispatch. Pre-commit failure may restore the prior compatible binary only after the candidate has been reaped and the prior pin still matches exactly. A restart reconciles the durable intent before any new database owner starts; unresolved phases require explicit operator recovery. Inspect the private `handoff/intent.json` beside the managed configuration before taking recovery action. Do not remove that journal or guess a rollback across schema changes.

### Managed accepted-request timing

The guard owns first-header acceptance before queueing or reading an upload. The new accepted cap is **1,470,000 ms**: 1,440,000 ms of work plus a 30,000 ms cleanup reserve. This is an intentional new finite limit after response commitment; healthy periodic chunks no longer permit an indefinitely long response. Existing 600,000 ms response-start, 120,000 ms idle, and user-agent-selected backend semantic/rescue budgets remain independent and may terminate earlier.

A caller may narrow the cap with `x-better-ccflare-timeout-ms`; it cannot expand the policy or provide trusted absolute timing. For a narrower cap, cleanup reserve is `min(30000, floor(cap/5))`. Managed timing uses the Linux boot-time clock from `/proc/uptime` with declared 10 ms precision and boot identity. It includes suspend time. Bun and Node `process.hrtime` do not share an origin in the tested Bun version and are deliberately not serialized as a common clock. Wall-clock changes cannot renew the budget. This shared-clock protocol is Linux-only; standalone ingress keeps its local lifecycle.

The bounded HMAC envelope binds original acceptance/deadlines, boot, ingress nonce, backend nonce/source/generation, request/attempt, method and path. Managed ingress rejects missing, malformed, mismatched or replayed envelopes before authentication, body admission or provider work. Pending requests retain their original acceptance when a new generation attaches. The backend publishes `accepted_request_deadline` to the native first-terminal arbiter before owned cancellation; a cancellation that remains unsettled at the original cleanup ceiling adds `cleanup_timeout` evidence without replacing that primary cause.

The supervisor permits the application's configured drain plus its 15-second cleanup watchdog and a 5-second cushion: 80 seconds at the 60-second application default. Native SQLite cleanup can still require forced retirement; candidate admission waits for positive PID/start reaping. Raising application drain requires the corresponding service stop allowance, not a hidden five-second kill.

The private ownership receipt is fsynced before backend spawn, then records the exact PID/start before readiness verification. A crash between those writes leaves an explicit ambiguous spawn and holds recovery. `/proc` permission, malformed identity and I/O errors are ambiguity; only an absent identity or positively different PID/start proves the prior process is gone. A later bootstrap of changed lifecycle/schema artifacts requires a durable receipt binding its new pin hash, binary hash, source and schema, plus no surviving recorded owner. This keeps a completed earlier transaction from either blocking a valid later bootstrap or authorizing a stale binary.

Owned response cancellation settles no later than the original accepted cleanup ceiling, including downstream cancellation and responses returned after expiry. Uncooperative cleanup emits the fixed secondary `cleanup_timeout` without replacing the selected primary cause. This bounds the wrapper's settlement; it does not prove an arbitrary noncooperating native resource obeyed cancellation. Supervisor process reaping remains the final ownership boundary.

The installed binary filename includes its complete content SHA-256 in addition to version and source identity. Rebuilding the same source from a different verified snapshot may produce different Bun bytes; each artifact remains immutable and a same-source retry can safely select the newly built artifact. Identical bytes reuse the existing path. Pruning protects the current and captured previous binary paths and removes only recognized guard/runner module sets.

Committed accepted-deadline failures use the downstream protocol: Messages gets an Anthropic SSE error, Responses gets `response.failed`, and Chat gets an OpenAI data-only error without a success `[DONE]`. Responses retains only bounded identity/model/sequence metadata while observing frames under the existing transport limits; it does not retain streamed output or fabricate usage. A committed non-stream JSON response, including Responses compact, closes with the typed internal cause rather than appending an SSE frame. The native terminal recorder still selects the cause before cancellation.
