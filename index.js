const express = require('express');
const dotenv = require('dotenv');

// Load environment variables from .env.local
dotenv.config({ path: '.env.local' });

// Configuration
const BASE_API_URL = process.env.BASE_API_URL;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10);
const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.API_KEY;
const COOKIE = process.env.COOKIE;
const GROUPS = process.env.GROUPS ? process.env.GROUPS.split(',').map(g => g.trim()).filter(Boolean) : [];

// Validate required configuration
if (!BASE_API_URL) {
  console.error('ERROR: BASE_API_URL is required in .env.local');
  process.exit(1);
}

// In-memory storage for latest poll result
let latestPollData = {
  lastCheckedAt: null,
  upstreamHttpStatus: null,
  rpcError: null,
  fetchError: null,
  nodesOnlineSummary: {
    totalNodes: 0,
    monitoredCount: 0,
    onlineCount: 0,
    offlineCount: 0,
    offlineUuids: [],
    unmonitoredCount: 0,
    unmonitoredUuids: []
  },
  computedBaseStatus: 503 // Default to 503 until first poll completes
};

/**
 * Performs a single poll to the upstream JSON-RPC2 API
 */
async function pollUpstreamAPI() {
  const startTime = new Date();
  const rpcEndpoint = `${BASE_API_URL}/api/rpc2`;

  // Reset error fields
  latestPollData.rpcError = null;
  latestPollData.fetchError = null;

  try {
    // Prepare headers
    const headers = {
      'Content-Type': 'application/json'
    };

    if (API_KEY) {
      headers['Authorization'] = `Bearer ${API_KEY}`;
    }

    if (COOKIE) {
      headers['Cookie'] = COOKIE;
    }

    // Step 1: Fetch node group information from common:getNodes
    const controller1 = new AbortController();
    const timeoutId1 = setTimeout(() => controller1.abort(), 5000);

    const nodesResponse = await fetch(rpcEndpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'common:getNodes',
        params: {}
      }),
      signal: controller1.signal
    });

    clearTimeout(timeoutId1);

    // Build a map of uuid -> group from common:getNodes
    const nodeGroupMap = {};
    if (nodesResponse.status === 200) {
      const nodesData = await nodesResponse.json();
      if (nodesData.result && typeof nodesData.result === 'object') {
        for (const uuid in nodesData.result) {
          const node = nodesData.result[uuid];
          if (node.group) {
            nodeGroupMap[uuid] = node.group;
          }
        }
      }
    }

    // Step 2: Fetch node status from common:getNodesLatestStatus
    const controller2 = new AbortController();
    const timeoutId2 = setTimeout(() => controller2.abort(), 5000);

    const response = await fetch(rpcEndpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'common:getNodesLatestStatus',
        params: {}
      }),
      signal: controller2.signal
    });

    clearTimeout(timeoutId2);

    latestPollData.upstreamHttpStatus = response.status;
    latestPollData.lastCheckedAt = startTime.toISOString();

    // Handle different HTTP status codes
    if (response.status >= 500) {
      // 5xx errors
      latestPollData.computedBaseStatus = 503;
      logPollResult('upstream_5xx_error');
      return;
    }

    if (response.status === 404) {
      latestPollData.computedBaseStatus = 404;
      logPollResult('upstream_404');
      return;
    }

    if (response.status === 400) {
      latestPollData.computedBaseStatus = 400;
      logPollResult('upstream_400');
      return;
    }

    if (response.status === 401 || response.status === 403) {
      latestPollData.computedBaseStatus = 401;
      logPollResult('upstream_unauthorized');
      return;
    }

    if (response.status === 200) {
      // Parse JSON-RPC response
      const jsonData = await response.json();

      // Check for JSON-RPC error
      if (jsonData.error) {
        latestPollData.rpcError = jsonData.error;
        latestPollData.computedBaseStatus = 502;
        logPollResult('rpc_error');
        return;
      }

      // Validate result exists
      if (!jsonData.result || typeof jsonData.result !== 'object') {
        latestPollData.rpcError = { message: 'Invalid or missing result' };
        latestPollData.computedBaseStatus = 502;
        logPollResult('invalid_result');
        return;
      }

      // Process nodes status
      const result = jsonData.result;
      const uuids = Object.keys(result);
      const totalNodes = uuids.length;

      if (totalNodes === 0) {
        // Empty result
        latestPollData.nodesOnlineSummary = {
          totalNodes: 0,
          monitoredCount: 0,
          onlineCount: 0,
          offlineCount: 0,
          offlineUuids: [],
          unmonitoredCount: 0,
          unmonitoredUuids: []
        };
        latestPollData.computedBaseStatus = 503;
        logPollResult('no_nodes');
        return;
      }

      // Count online/offline nodes
      let monitoredCount = 0;
      let onlineCount = 0;
      const offlineUuids = [];
      const unmonitoredUuids = [];

      for (const uuid of uuids) {
        const node = result[uuid];

        // When GROUPS is set, only nodes in those groups are monitored.
        const nodeGroup = nodeGroupMap[uuid];
        if (GROUPS.length > 0 && (!nodeGroup || !GROUPS.includes(nodeGroup))) {
          unmonitoredUuids.push(uuid);
          continue; // Skip this node
        }

        monitoredCount++;

        if (node.online === true) {
          onlineCount++;
        } else {
          offlineUuids.push(uuid);
        }
      }

      const offlineCount = monitoredCount - onlineCount;

      latestPollData.nodesOnlineSummary = {
        totalNodes,
        monitoredCount,
        onlineCount,
        offlineCount,
        offlineUuids,
        unmonitoredCount: unmonitoredUuids.length,
        unmonitoredUuids
      };

      // Determine status: 200 only if ALL monitored nodes are online
      if (monitoredCount === 0) {
        latestPollData.computedBaseStatus = 503;
        logPollResult('no_monitored_nodes');
      } else if (onlineCount === monitoredCount) {
        latestPollData.computedBaseStatus = 200;
        logPollResult('all_online');
      } else {
        latestPollData.computedBaseStatus = 503;
        logPollResult('some_offline');
      }
    } else {
      // Unexpected status code
      latestPollData.computedBaseStatus = 503;
      logPollResult('unexpected_status');
    }

  } catch (error) {
    // Network error or timeout
    latestPollData.fetchError = error.message;
    latestPollData.computedBaseStatus = 503;
    latestPollData.lastCheckedAt = startTime.toISOString();
    logPollResult('fetch_error');
  }
}

/**
 * Logs the poll result with relevant details
 */
function logPollResult(statusString) {
  const { lastCheckedAt, upstreamHttpStatus, nodesOnlineSummary, computedBaseStatus, fetchError, rpcError } = latestPollData;

  console.log(`[${lastCheckedAt}] Poll completed:`, {
    status: statusString,
    upstreamHttpStatus,
    nodes: `${nodesOnlineSummary.onlineCount}/${nodesOnlineSummary.monitoredCount} monitored online`,
    totalNodes: nodesOnlineSummary.totalNodes,
    computedBaseStatus,
    error: fetchError || (rpcError ? JSON.stringify(rpcError) : null)
  });
}

/**
 * Starts the polling loop
 */
function startPolling() {
  console.log(`Starting polling every ${POLL_INTERVAL_MS}ms...`);

  // Poll immediately on startup
  pollUpstreamAPI();

  // Then poll at regular intervals
  setInterval(pollUpstreamAPI, POLL_INTERVAL_MS);
}

// Initialize Express app
const app = express();

/**
 * GET / - Base route that returns status based on latest poll
 */
app.get('/', (req, res) => {
  const { computedBaseStatus, lastCheckedAt, nodesOnlineSummary } = latestPollData;

  // Determine status string
  let statusString;
  if (computedBaseStatus === 200) {
    statusString = 'all_online';
  } else if (latestPollData.fetchError) {
    statusString = 'upstream_error';
  } else if (latestPollData.rpcError) {
    statusString = 'rpc_error';
  } else if (nodesOnlineSummary.offlineCount > 0) {
    statusString = 'some_offline';
  } else if (nodesOnlineSummary.monitoredCount === 0 && nodesOnlineSummary.totalNodes > 0) {
    statusString = 'no_monitored_nodes';
  } else {
    statusString = 'error';
  }

  res.status(computedBaseStatus).json({
    status: statusString,
    lastCheckedAt,
    onlineCount: nodesOnlineSummary.onlineCount,
    monitoredCount: nodesOnlineSummary.monitoredCount,
    totalNodes: nodesOnlineSummary.totalNodes,
    offlineUuids: nodesOnlineSummary.offlineUuids,
    unmonitoredCount: nodesOnlineSummary.unmonitoredCount,
    unmonitoredUuids: nodesOnlineSummary.unmonitoredUuids
  });
});

/**
 * GET /health - Always returns 200 with basic health info
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    lastCheckedAt: latestPollData.lastCheckedAt,
    pollIntervalMs: POLL_INTERVAL_MS
  });
});

/**
 * GET /debug - Returns full cached poll data for debugging
 */
app.get('/debug', (req, res) => {
  res.status(200).json(latestPollData);
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Configuration:`);
  console.log(`  - BASE_API_URL: ${BASE_API_URL}`);
  console.log(`  - POLL_INTERVAL_MS: ${POLL_INTERVAL_MS}`);
  console.log(`  - API_KEY: ${API_KEY ? '***set***' : 'not set'}`);
  console.log(`  - COOKIE: ${COOKIE ? '***set***' : 'not set'}`);
  console.log(`  - GROUPS: ${GROUPS.length > 0 ? GROUPS.join(', ') : 'all'}`);
  console.log('');

  // Start polling
  startPolling();
});
