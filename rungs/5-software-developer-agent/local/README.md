# Local Docker Environment

This directory contains Docker Compose configuration for local development services.

## Services Included

### Core Services (Default Profile)
- **DynamoDB Local** (port 8000) - Application data storage
- **PostgreSQL** (port 5432) - LangGraph persistence

### Optional Services (Full Profile)
- **Redis** (port 6379) - Caching and session management  
- **pgAdmin** (port 5050) - PostgreSQL web interface

## Quick Start

### 1. Start Core Services
```bash
# Navigate to local directory
cd ./local
export AWS_ACCESS_KEY_ID=dummy
export AWS_SECRET_ACCESS_KEY=dummy

# Start DynamoDB and PostgreSQL
docker-compose up -d
```

### 2. Start All Services (Including Optional)
```bash
# Start everything including Redis and pgAdmin
docker-compose --profile full up -d
```

### 3. Check Status
```bash
# View running containers
docker-compose ps

# Check service health
docker-compose logs

# Follow logs in real-time
docker-compose logs -f
```

## Service Details

### DynamoDB Local
- **URL**: http://localhost:8000
- **Access**: Use dummy AWS credentials
- **Data**: Persisted in `./docker/dynamodb/`

```bash
# Test connection
curl http://localhost:8000/
```

### PostgreSQL
- **Host**: localhost:5432
- **Database**: langgraph_checkpoints
- **User**: postgres
- **Password**: langgraph

```bash
# Connect via psql
docker-compose exec postgres psql -U postgres -d langgraph_checkpoints

# Check existing tables
docker-compose exec postgres psql -U postgres -d langgraph_checkpoints -c "\dt"

# View table schemas
docker-compose exec postgres psql -U postgres -d langgraph_checkpoints -c "\d checkpoints"
docker-compose exec postgres psql -U postgres -d langgraph_checkpoints -c "\d checkpoint_writes"
```

#### LangGraph Table Management

**Check if LangGraph tables exist:**
```bash
# List all tables in the checkpoints database
docker-compose exec postgres psql -U postgres -d langgraph_checkpoints -c "SELECT tablename FROM pg_tables WHERE schemaname='public';"

# Check specific LangGraph tables
docker-compose exec postgres psql -U postgres -d langgraph_checkpoints -c "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'checkpoints');"
```

**Create LangGraph tables if missing:**
```bash
# Create checkpoints table
docker-compose exec postgres psql -U postgres -d langgraph_checkpoints -c "
CREATE TABLE IF NOT EXISTS checkpoints (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    type TEXT,
    checkpoint JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

CREATE INDEX IF NOT EXISTS ix_checkpoints_thread_id ON checkpoints (thread_id);
CREATE INDEX IF NOT EXISTS ix_checkpoints_type ON checkpoints (type);
CREATE INDEX IF NOT EXISTS ix_checkpoints_parent_id ON checkpoints (parent_checkpoint_id);
"

# Create checkpoint writes table
docker-compose exec postgres psql -U postgres -d langgraph_checkpoints -c "
CREATE TABLE IF NOT EXISTS checkpoint_writes (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    type TEXT,
    value JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

CREATE INDEX IF NOT EXISTS ix_checkpoint_writes_thread_id ON checkpoint_writes (thread_id);
CREATE INDEX IF NOT EXISTS ix_checkpoint_writes_checkpoint_id ON checkpoint_writes (checkpoint_id);
"
```

**Verify table creation:**
```bash
# Count records in tables (should be 0 for new installation)
docker-compose exec postgres psql -U postgres -d langgraph_checkpoints -c "SELECT COUNT(*) FROM checkpoints;"
docker-compose exec postgres psql -U postgres -d langgraph_checkpoints -c "SELECT COUNT(*) FROM checkpoint_writes;"
```

### Redis (Optional)
- **URL**: redis://localhost:6379
- **Data**: Persisted in Docker volume

```bash
# Test connection
docker-compose exec redis redis-cli ping
```

### pgAdmin (Optional)
- **URL**: http://localhost:5050
- **Email**: admin@openswe.local
- **Password**: admin

## Ngrok Integration

For testing GitHub webhooks and external integrations:

### Install Ngrok
```bash
# Install ngrok (if not already installed)
# Visit https://ngrok.com/download or use package manager

# macOS
brew install ngrok/ngrok/ngrok

# Linux (snap)
sudo snap install ngrok

# Ubuntu/Debian
curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt update && sudo apt install ngrok
```

### Ngrok Commands
```bash
# Expose local development server (adjust port as needed)
ngrok http 3000

# Expose with custom subdomain (requires paid plan)
ngrok http 3000 --subdomain=my-openswe-dev

# Expose multiple ports
ngrok http 3000 --region=us --name=web
ngrok http 2024 --region=us --name=langgraph

# Start ngrok with config file
ngrok start --all

# Check ngrok status
curl http://localhost:4040/api/tunnels
```

### GitHub Webhook Configuration
```bash
# 1. Start ngrok for your web app
ngrok http 3000

# 2. Copy the https URL (e.g., https://abc123.ngrok.io)
# 3. In GitHub repository settings > Webhooks, set:
#    Payload URL: https://abc123.ngrok.io/api/webhooks/github
#    Content type: application/json
#    Events: Issues, Issue comments, Pull requests

# 4. Test webhook delivery in GitHub webhook settings
```

## Environment Configuration

### Application Settings
Add to your application's `.env` file:

```bash
# DynamoDB Local
DYNAMODB_ENDPOINT=http://localhost:8000
AWS_ACCESS_KEY_ID=dummy
AWS_SECRET_ACCESS_KEY=dummy

# PostgreSQL for LangGraph
LANGGRAPH_CHECKPOINTER=postgres://postgres:langgraph@localhost:5432/langgraph_checkpoints

# Redis (optional)
REDIS_URL=redis://localhost:6379

# LangGraph API
LANGGRAPH_API_URL=http://localhost:2024

# GitHub Webhooks (with ngrok)
WEBHOOK_URL=https://your-ngrok-url.ngrok.io
```

## Management Commands

### Starting and Stopping
```bash
# Start core services in detached mode
docker-compose up -d

# Start with full profile
docker-compose --profile full up -d

# Stop all services
docker-compose down

# Stop and remove volumes (destructive)
docker-compose down -v

# Restart specific service
docker-compose restart postgres
docker-compose restart dynamodb-local
```

### Container Management
```bash
# List running containers
docker-compose ps

# Stop specific containers
docker-compose stop postgres dynamodb-local

# Remove specific containers
docker-compose rm postgres dynamodb-local

# Kill containers by name
docker rm -f langgraph-postgres dynamodb-local

# Remove all containers matching pattern
docker ps -aq --filter "name=langgraph*" | xargs docker rm -f
```

### Debugging
```bash
# View service status
docker-compose ps

# Check logs for all services
docker-compose logs

# Check logs for specific service
docker-compose logs postgres
docker-compose logs dynamodb-local

# Follow logs in real-time
docker-compose logs -f dynamodb-local

# Execute commands in containers
docker-compose exec postgres psql -U postgres
docker-compose exec redis redis-cli

# Inspect container resource usage
docker stats langgraph-postgres dynamodb-local
```

### Data Management
```bash
# Backup PostgreSQL data
docker-compose exec postgres pg_dump -U postgres langgraph_checkpoints > backup.sql

# Restore PostgreSQL data
docker-compose exec -T postgres psql -U postgres langgraph_checkpoints < backup.sql

# Export DynamoDB data (requires AWS CLI)
docker-compose exec dynamodb-local sh

# Clear all data (destructive)
docker-compose down -v
docker-compose up -d

# Clean up Docker system
docker system prune -a --volumes
```

## Database Verification

### PostgreSQL Health Check
```bash
# Basic connection test
docker-compose exec postgres pg_isready -U postgres

# Database exists check
docker-compose exec postgres psql -U postgres -c "SELECT 1 FROM pg_database WHERE datname='langgraph_checkpoints';"

# Table verification
docker-compose exec postgres psql -U postgres -d langgraph_checkpoints -c "
SELECT 
    table_name, 
    table_type 
FROM information_schema.tables 
WHERE table_schema = 'public' 
ORDER BY table_name;
"

# Index verification
docker-compose exec postgres psql -U postgres -d langgraph_checkpoints -c "
SELECT 
    indexname, 
    tablename, 
    indexdef 
FROM pg_indexes 
WHERE schemaname = 'public' 
ORDER BY tablename, indexname;
"
```

### DynamoDB Health Check
```bash
# Service availability
curl -f http://localhost:8000/ || echo "DynamoDB not responding"
# List tables (requires AWS CLI with dummy credentials)
aws dynamodb list-tables --endpoint-url http://localhost:8000 --region us-east-1
```

### DynamoDB Delete Items
```bash
aws dynamodb delete-table \
    --table-name openswe-run-metadata \
    --endpoint-url http://localhost:8000 \
    --region us-east-1 \
    --no-cli-pager

aws dynamodb create-table \
    --table-name openswe-run-metadata \
    --attribute-definitions AttributeName=issueKey,AttributeType=S \
    --key-schema AttributeName=issueKey,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --endpoint-url http://localhost:8000 \
    --region us-east-1

aws dynamodb scan \
    --table-name openswe-run-metadata \
    --endpoint-url http://localhost:8000 \
    --region us-east-1 \
    --no-cli-pager \
    --query "reverse(sort_by(Items, &issueKey.S))[:3]"

aws dynamodb scan \
    --table-name openswe-run-metadata \
    --endpoint-url http://localhost:8000 \
    --region us-east-1 \
    --query "Items[*].issueKey.S" \
    --output text | tr '\t' '\n' | while read -r item_key; do
  [ -n "$item_key" ] && aws dynamodb delete-item \
    --table-name openswe-run-metadata \
    --key "{\"issueKey\": {\"S\": \"$item_key\"}}" \
    --endpoint-url http://localhost:8000 \
    --region us-east-1 \
    --no-cli-pager || echo "Skipping empty item"
done

```

## Troubleshooting

### Port Conflicts
```bash
# Check what's using ports
lsof -i :8000  # DynamoDB
lsof -i :5432  # PostgreSQL  
lsof -i :6379  # Redis
lsof -i :5050  # pgAdmin
lsof -i :4040  # Ngrok

# Kill processes using specific ports
sudo kill -9 $(lsof -t -i:8000)
sudo kill -9 $(lsof -t -i:5432)

# Stop conflicting system services
sudo service postgresql stop
sudo service redis-server stop
```

### Permission Issues
```bash
# Ensure data directories exist with correct permissions
mkdir -p ./docker/{dynamodb,postgres}
chmod -R 755 ./docker
chown -R $USER:$USER ./docker

# Fix Docker socket permissions
sudo usermod -aG docker $USER
newgrp docker
```

### Health Checks
```bash
# Check service health status
docker-compose ps

# Manual health verification
curl -f http://localhost:8000/ # DynamoDB
docker-compose exec postgres pg_isready -U postgres # PostgreSQL
docker-compose exec redis redis-cli ping # Redis (if running)

# Container resource monitoring
docker stats --no-stream
```

### Common Issues

**PostgreSQL initialization fails:**
```bash
# Remove and recreate volumes
docker-compose down -v
docker volume prune -f
docker-compose up -d
```

**DynamoDB shows unhealthy:**
```bash
# Check if port is accessible
curl http://localhost:8000/
# DynamoDB doesn't have proper health checks, "unhealthy" status is expected
```

**Tables not created automatically:**
```bash
# Manually run the table creation commands above
# Or restart containers with updated init scripts
docker-compose down
docker-compose up -d
```

## Directory Structure

```
local/
├── docker-compose.yml      # Main compose file
├── .env.example           # Environment template  
├── README.md              # This file
├── .gitignore            # Version control exclusions
└── docker/               # Data persistence and config
    ├── dynamodb/         # DynamoDB data directory
    └── postgres/         # PostgreSQL initialization scripts
        └── 01-init.sql   # Database and table creation
```

## Integration with Main Application

This Docker setup provides the infrastructure services that your OpenSWE application depends on:

1. **DynamoDB Local** stores run metadata and issue mappings
2. **PostgreSQL** provides LangGraph checkpoint persistence for interrupted workflows
3. **Redis** (optional) can be used for caching and session management
4. **Ngrok** enables webhook testing with external services like GitHub

Your application should be configured to connect to these services when running in development mode. The PostgreSQL checkpointer is essential for resuming interrupted LangGraph workflows across application restarts.
