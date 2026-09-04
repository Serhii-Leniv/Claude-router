'use strict';
// SubagentStart hook: tells the proxy which agent type this subagent is, so an
// operator's `agents` mapping can pin third-party agents by name (the marker
// covers the agents this plugin ships regardless). Fire-and-forget, 300 ms,
// always exits 0.
const { proxyPort, readStdinJson, request } = require('./common.js');

async function main() {
  const input = await readStdinJson();
  const agentId = typeof input.agent_id === 'string' ? input.agent_id : null;
  const agentType = typeof input.agent_type === 'string' ? input.agent_type : null;
  if (!agentId || !agentType) return;
  await request(proxyPort(), 'POST', '/api/agents', {
    agentId,
    agentType,
    sessionId: typeof input.session_id === 'string' ? input.session_id : undefined,
  });
}

main().catch(() => { /* never block a subagent */ }).finally(() => process.exit(0));
