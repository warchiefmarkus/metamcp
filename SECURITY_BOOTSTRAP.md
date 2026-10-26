# Secure first-run setup for MetaMCP

New clones and new machines must not ship a usable administrator account or a
preset password. Never commit real credentials to Git.

## Where to configure

- Standard source checkout: create a local `.env.local` from `example.env`
  and use the environment file loaded by your launcher.
- Windows Host: `C:\DEV\LLM\MetaMCP.WindowsHost\config\.env.local`
  (or `config\.env.local` inside another installed Host directory).
- Proxmox Linux Host: `/root/mcp/metamcp-host/current/config/.env.local`
  (or the installed Host's `config/.env.local`).

Example (replace placeholders **before** the first startup):

```dotenv
BOOTSTRAP_ENABLE=true
BOOTSTRAP_FAIL_HARD=true
BOOTSTRAP_USER_EMAIL=you@yourdomain.com
BOOTSTRAP_USER_NAME=Admin
BOOTSTRAP_USER_PASSWORD=replace-with-your-unique-strong-passphrase
BOOTSTRAP_RECREATE_USER=false
BOOTSTRAP_DISABLE_REGISTRATION_UI=true
BOOTSTRAP_DISABLE_REGISTRATION_SSO=true
```

The password must be 20–128 characters, not a sample/default credential,
include at least two character classes and at least eight distinct characters.
Do not reuse passwords between machines unless deliberately managing a shared
secret with an appropriate credential manager.

### Enforcement

On **new builds** of the updated backend, startup rejects insecure, missing-half,
or example bootstrap credentials **before binding the HTTP server**, even if
`BOOTSTRAP_ENABLE=false`. `BOOTSTRAP_USERS` is subject to the same policy.
Absent bootstrap credentials create **no default user**; UI/SSO signup are disabled
by default. Configure the initial admin explicitly to avoid locking yourself out.

Updating `BOOTSTRAP_USER_PASSWORD` in the environment **does not rotate an
existing Better Auth database password**. For an existing installation change the
password in Better Auth (or through the authorized secure rotation procedure),
revoke sessions and tokens, and synchronize the environment afterwards.

### Existing old laptop or deployment

An already built executable from an **older commit** will not acquire this
protection merely because Git was updated elsewhere. Until its code is upgraded
and its admin rotated, keep its HTTP/listening services behind a firewall or
disconnected from the public Internet. Never expose its default login or signup
routes via a public HTTPS reverse tunnel.

Do not expose bootstrap passwords, Better Auth secrets, API keys, session cookies,
or OAuth tokens in tickets, screenshots, commit diffs, or logs.
