# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue or PR.

Use GitHub's private advisory form:
**https://github.com/Serhii-Leniv/claude-router/security/advisories/new**

We'll acknowledge the report, investigate, and coordinate a fix and disclosure timeline with you. Please give us a reasonable window to release a fix before any public disclosure.

## Scope & context

`claude-router` handles Anthropic credentials and, in its proxy mode, forwards API traffic. A few things worth knowing when assessing impact:

- **The proxy binds `127.0.0.1` by default and does not authenticate incoming requests.** With the `bedrock`/`vertex` providers it uses the operator's cloud credentials, so exposing it on a public interface would let any caller spend those credentials. The localhost default is a deliberate security boundary — reports that depend on someone overriding `--host`/`host` to a public bind should note that.
- Credentials from `x-api-key` / `Authorization` headers are used per-request and cached in-memory only (an LRU of SDK clients); they are not written to disk.
- Route history (`~/.claude-router/history.jsonl`) records token counts and costs, not prompt or response content.

Reports that demonstrate credential leakage, request smuggling, SSRF beyond the pinned Anthropic upstream, or a way to make the proxy call an unintended host are especially valuable.

## Supported versions

This is a pre-1.0 project; security fixes land on the latest published version. Please test against the newest release before reporting.
