# MetaMCP Proxmox backend snapshot — secure refresh rotation

This directory records the **Proxmox-specific** backend deployed on 26 October 2026, not a drop-in replacement for the `apps/backend` directory of the Windows Host branch.

## Why it is separate

The Proxmox installation already contained features absent from the Windows source branch, including request auditing, forwarded-header support, and Proxmox-specific migrations `0014–0018`. Overwriting it with the Windows build would silently remove those features and conflict with existing Drizzle migration IDs.

`backend/src`, `backend/drizzle`, and the backend build scripts are a sanitized source snapshot from the active Proxmox installation (no environment files, databases, installed packages, logs, or credentials).

## Implemented

- `0019_secure_refresh_rotation.sql`: additive new table `oauth_refresh_tokens` and `oauth_access_tokens.refresh_family_id`.
- 384-bit opaque refresh tokens; only SHA-256 token hashes are persisted.
- Single-use exchange using PostgreSQL row locks; 30-day refresh and 1-hour access lifetimes.
- Client-bound and resource-string-bound refresh; old tokens cannot be replayed.
- On replay: revoke refresh-token family and related access tokens.
- No new plaintext refresh token stored in the old `oauth_access_tokens.refresh_token` field.
- Existing API key, administrator, frontend, request-audit, and custom Proxmox behavior retained.

## Deployment and validation

Active Linux host: `/root/mcp/metamcp-host/current` (symlink to `releases/20261026-secure-refresh-proxmox/linux-x64`).

Before deployment a PostgreSQL custom-format backup was created at `/root/mcp/metamcp-host/ops/proxmox-pre-refresh-20261026.dump`. The SQL migration followed existing Proxmox journal entries; the new backend was bundled with tsup 8.5.0 and activated via the `metamcp-host` systemd unit. Both local frontend and backend health checks passed.

The isolated E2E test `/root/mcp/metamcp-host/ops/test-secure-refresh-e2e.mjs` passed: DCR, resource mismatch rejection, initial refresh, hashed storage, replay rejection, family revocation, and access revocation. Test client and token records were cleaned afterward.

The main public ChatGPT OAuth gateway remains the separate Windows Legion installation. Proxmox still has its own independent OAuth issuer/clients and is **not** interchangeable with Legion token storage.

## Repeatable maintenance

Preserve this directory's backend source and migration journal as the Proxmox baseline for future changes. Do not replace its `drizzle` directory with the Windows `apps/backend/drizzle` directory: their migration IDs diverge.

Never commit or copy `config/.env.local`, database backups, Better Auth secrets, plaintext API keys, access tokens, or runtime logs into this directory. Future releases must retain the host's existing config and PostgreSQL database, use a new versioned release directory, and health-check before switching the `current` symlink.
