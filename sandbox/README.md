# Sandbox

Run claude-router and Claude Code together in a container, isolated from the host. Nothing is installed globally, no host environment variable is set, and the host's `~/.claude` and `~/.claude-router` are never mounted.

```bash
sandbox/run.sh build                      # once, and after code changes
ANTHROPIC_API_KEY=sk-… sandbox/run.sh     # interactive Claude Code through the proxy
sandbox/run.sh stats                      # what the sandbox's ledger says
sandbox/run.sh proxy-log 100              # the proxy's verbose routing log
```

Inside the container: Claude Code → wire recorder (`:4200`, captures the structural headers and bodies to `sandbox/.wire/`) → claude-router (`:4000`, `--force-route --session-model opus --restore-delegation`, role routing on) → Anthropic. The orchestration plugin is loaded with `--plugin-dir /app/plugin`, so the shipped agents and policy are exercised without installing them anywhere.

## Verifying orchestration mode

1. Put a project in `sandbox/workspace/` (it is mounted at `/work`).
2. `sandbox/run.sh` and, at the prompt, ask for something that warrants a lookup: *"use recon to find where the config loader is defined"*.
3. On session start you should see the policy followed by `claude-router: enforcing — session pinned to opus, subagent roles routed by the proxy`.
4. `sandbox/run.sh proxy-log` shows the coordinator turn as `session:coordinator-pinned` and the subagent request as `role:recon → haiku`.
5. `sandbox/run.sh stats` shows a dispatch rate and a `By role` line with `recon`.
6. `SANDBOX_ROLE_ROUTING=off sandbox/run.sh` repeats the same task as the A/B baseline; compare the two `stats` outputs.

The wire capture in `sandbox/.wire/*.json.gz` records each subagent request's `system` array and `x-claude-code-*` headers, which settles how Claude Code serialises the agent body (whether the role marker lands at a block boundary). Those files contain prompts and code: delete them when done, never commit them.

## Cost

Every turn spends real money on the credentials you pass in. A single recon dispatch is a few cents.
