# RPC2API - Node.js Polling Service

A simple Node.js web service that continuously polls a Komari JSON-RPC2 API and exposes HTTP endpoints whose status codes reflect the health of monitored nodes.

## Why This Project?

This service solves a common monitoring challenge: **checking the health of multiple Komari nodes with a single HTTP call**.

Instead of making individual JSON-RPC2 calls to check each node's status, this service:
- Continuously polls the Komari RPC2 API in the background
- Aggregates the status of all monitored nodes
- Exposes a simple HTTP endpoint that returns status codes based on overall health
- Enables easy integration with uptime monitoring tools (UptimeRobot, Pingdom, etc.)

**Use Case**: Monitor dozens of Komari nodes with one uptime check instead of configuring individual monitors for each node. The service returns HTTP 200 only when ALL nodes are online, making it perfect for alerting when any node goes down.

## Features

- Polls a JSON-RPC2 API at configurable intervals
- Exposes HTTP status codes based on node health
- Returns 200 only when ALL nodes are online
- Returns 503 when any node is offline or upstream errors occur
- Handles various upstream error conditions (404, 401, 5xx, etc.)
- Supports Bearer token and Cookie authentication
- Provides health check and debug endpoints

## Installation

Clone the repository:

```bash
git clone https://github.com/tonyliuzj/rpc2api.git
cd rpc2api
```

Install dependencies:

```bash
npm install
```

## Configuration

Copy the example configuration file and edit it with your settings:

```bash
cp example.env.local .env.local
```

Then edit `.env.local` with your configuration:

```bash
# Required: Base URL of the Komari API (no trailing slash)
BASE_API_URL=https://example.com

# Optional: Polling interval in milliseconds (default: 5000)
POLL_INTERVAL_MS=5000

# Optional: Server port (default: 3000)
PORT=3000

# Optional: API key for Bearer token authentication
# API_KEY=your_api_key_here

# Optional: Cookie for cookie-based authentication
# COOKIE=session=your_session_cookie_here
```

## Running the Service

```bash
npm start
```

The service will:
1. Start the Express server on the configured PORT
2. Begin polling immediately
3. Continue polling at POLL_INTERVAL_MS intervals
4. Log each poll result with timestamp and status

## Production Deployment with PM2

PM2 is a production process manager for Node.js applications that keeps your app running, handles restarts, and provides monitoring.

### Install PM2 globally

```bash
npm install -g pm2
```

### Start the service with PM2

```bash
pm2 start index.js --name rpc2api
```

### Useful PM2 commands

```bash
# View running processes
pm2 list

# View logs
pm2 logs rpc2api

# Monitor CPU/memory usage
pm2 monit

# Restart the service
pm2 restart rpc2api

# Stop the service
pm2 stop rpc2api

# Remove from PM2
pm2 delete rpc2api
```

### Update the deployed application

When you need to update the code:

```bash
# Pull latest changes
git pull

# Install any new dependencies
npm install

# Restart the service with PM2
pm2 restart rpc2api
```

### Auto-start on system reboot

To ensure the service starts automatically after a system reboot:

```bash
# Save the current PM2 process list
pm2 save

# Generate and configure startup script
pm2 startup
```

Follow the instructions provided by the `pm2 startup` command (it will give you a command to run with sudo).

## API Endpoints

### GET /

Main status endpoint. Returns HTTP status code based on latest poll result.

**Status Code Rules:**
- `200` - All nodes are online (onlineCount === totalNodes > 0)
- `503` - At least one node is offline, or no poll completed yet, or upstream fetch failed, or upstream 5xx error, or empty nodes
- `502` - Upstream returned 200 but JSON-RPC error or invalid result
- `404` - Upstream returned 404
- `400` - Upstream returned 400
- `401` - Upstream returned 401 or 403

**Response Body:**
```json
{
  "status": "all_online",
  "lastCheckedAt": "2025-12-30T12:34:56.789Z",
  "onlineCount": 5,
  "totalNodes": 5,
  "offlineUuids": []
}
```

**Status Values:**
- `all_online` - All nodes are online (200)
- `some_offline` - One or more nodes are offline (503)
- `upstream_error` - Network/timeout error (503)
- `rpc_error` - JSON-RPC error (502)
- `error` - Other error condition

### GET /health

Health check endpoint. Always returns 200.

**Response:**
```json
{
  "ok": true,
  "lastCheckedAt": "2025-12-30T12:34:56.789Z",
  "pollIntervalMs": 5000
}
```

### GET /debug

Debug endpoint. Returns full internal poll state.

**Response:**
```json
{
  "lastCheckedAt": "2025-12-30T12:34:56.789Z",
  "upstreamHttpStatus": 200,
  "rpcError": null,
  "fetchError": null,
  "nodesOnlineSummary": {
    "totalNodes": 5,
    "onlineCount": 4,
    "offlineCount": 1,
    "offlineUuids": ["uuid-123"]
  },
  "computedBaseStatus": 503
}
```

## Upstream API Details

The service polls the JSON-RPC2 endpoint at `{BASE_API_URL}/api/rpc2` with:

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "common:getNodesLatestStatus",
  "params": {}
}
```

**Expected Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "uuid1": { "online": true, ... },
    "uuid2": { "online": false, ... }
  }
}
```

Node status is determined solely by the `online` boolean field.

## Logging

Each poll logs output in the format:
```
[2025-12-30T12:34:56.789Z] Poll completed: {
  status: 'all_online',
  upstreamHttpStatus: 200,
  nodes: '5/5 online',
  computedBaseStatus: 200,
  error: null
}
```

## Error Handling

- **Network/Timeout Errors**: 5-second timeout on upstream requests, returns 503
- **Upstream 5xx**: Returns 503
- **Upstream 404**: Returns 404
- **Upstream 400**: Returns 400
- **Upstream 401/403**: Returns 401
- **JSON-RPC Error**: Returns 502
- **Invalid Result**: Returns 502
- **Empty Nodes**: Returns 503

## Requirements

- Node.js >= 18 (for native fetch support)
- Express
- dotenv

## License

ISC
