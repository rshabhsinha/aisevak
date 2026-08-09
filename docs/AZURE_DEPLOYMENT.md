# Azure deployment operations

This runbook is intentionally sanitized. Hostnames, IP addresses, Azure resource names, usernames, host paths, and private-key locations are kept outside the repository.

## Load the private deployment configuration

The exact deployment values are stored locally beside the SSH key in:

```text
$HOME/Documents/aisevak-azure-deployment.env
```

That file defines the following variables:

| Variable | Purpose |
| --- | --- |
| `AISEVAK_APP_URL` | Public application URL |
| `AISEVAK_DEPLOY_HOST` | SSH hostname |
| `AISEVAK_PUBLIC_HOST` | Hostname used by Caddy |
| `AISEVAK_AZURE_REGION` | Azure region |
| `AISEVAK_RESOURCE_GROUP` | Azure resource group |
| `AISEVAK_VM_NAME` | Azure VM name |
| `AISEVAK_VM_SIZE` | Azure VM size |
| `AISEVAK_PUBLIC_IP` | Static public IP |
| `AISEVAK_NSG_NAME` | Network security group |
| `AISEVAK_SSH_ALLOWED_IP` | Source IP currently allowed for SSH |
| `AISEVAK_SSH_USER` | VM administrator username |
| `AISEVAK_SSH_KEY` | Local private-key path |
| `AISEVAK_LOCAL_REPO` | Local source checkout |
| `AISEVAK_REMOTE_SOURCE` | Source staging directory on the VM |
| `AISEVAK_ACTIVE_RELEASE` | Active release directory on the VM |
| `AISEVAK_DATA_ROOT` | Persistent application data directory |
| `AISEVAK_ENV_FILE` | Production environment file on the VM |
| `AISEVAK_BACKUP_DIR` | Database backup directory on the VM |
| `AISEVAK_COMPOSE_PROJECT` | Docker Compose project name |
| `AISEVAK_CADDYFILE` | Local private Caddy configuration |

Load it before running commands from this document:

```bash
source "$HOME/Documents/aisevak-azure-deployment.env"
```

Never copy the deployment environment file, the Caddy configuration, the SSH private key, or the production environment file into this repository.

## SSH into the VM

Make sure the key is readable only by the local user:

```bash
chmod 600 "$AISEVAK_SSH_KEY"
```

Connect using the configured hostname:

```bash
ssh -i "$AISEVAK_SSH_KEY" "$AISEVAK_SSH_USER@$AISEVAK_DEPLOY_HOST"
```

The Azure network security group should permit SSH only from the configured source IP. If SSH times out after changing networks:

1. Find the current public IP with `curl -4 https://api.ipify.org`.
2. In Azure Portal, open the configured resource group and network security group.
3. Update the SSH inbound rule to **My IP address**, save it, and update `AISEVAK_SSH_ALLOWED_IP` in the private deployment file.

HTTP and HTTPS remain public for the web application. Database and API service ports should bind only to VM loopback, while Caddy remains the public HTTPS reverse proxy.

## Deploy an update

The VM does not need GitHub credentials. Updates are copied from the local checkout while repository metadata, secrets, build output, and local application state are excluded.

First inspect exactly what will be deployed:

```bash
cd "$AISEVAK_LOCAL_REPO"
git status --short --branch
```

Copy the current checkout to the VM:

```bash
rsync -az --delete \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='.aisevak-dev/' \
  --exclude='.aisevak-managed/' \
  --exclude='data/' \
  --exclude='tmp/' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='coverage/' \
  -e "ssh -i $AISEVAK_SSH_KEY" \
  "$AISEVAK_LOCAL_REPO/" \
  "$AISEVAK_SSH_USER@$AISEVAK_DEPLOY_HOST:$AISEVAK_REMOTE_SOURCE/"
```

Build and activate the copied release:

```bash
ssh -i "$AISEVAK_SSH_KEY" \
  "$AISEVAK_SSH_USER@$AISEVAK_DEPLOY_HOST" \
  "cd '$AISEVAK_REMOTE_SOURCE' && sudo ./scripts/install.sh"
```

The installer builds before activation, preserves the production environment, persistent data, and the PostgreSQL volume, and retains the configured number of releases. Preserving a PostgreSQL volume does not by itself make data-directory layouts compatible. On the first update from the legacy mount to PostgreSQL 18's parent mount, the installer quiesces database writers, requires a compressed backup, places or verifies the stopped cluster under `18/docker`, validates it, and aborts before activation if the migration fails.

## Update Caddy

The real Caddy configuration is stored outside the repository at `AISEVAK_CADDYFILE`. Upload and activate it when it changes:

```bash
scp -i "$AISEVAK_SSH_KEY" \
  "$AISEVAK_CADDYFILE" \
  "$AISEVAK_SSH_USER@$AISEVAK_DEPLOY_HOST:/tmp/aisevak-Caddyfile"

ssh -i "$AISEVAK_SSH_KEY" \
  "$AISEVAK_SSH_USER@$AISEVAK_DEPLOY_HOST" \
  'sudo install -m 0644 /tmp/aisevak-Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy'
```

Verify the deployment:

```bash
curl -fsS "$AISEVAK_APP_URL/api/health"
```

The expected response is `{"ok":true}`.

After the first deployment, sign in as an owner and open **Manage → ChatGPT**. Select **Connect ChatGPT**, finish the device-code flow in the browser, and wait for Aisevak to show the connection as ready. The encrypted connection is shared by the host-native runner; no Codex login file or OpenAI token needs to be copied to the VM manually.

## Common operations

View container state:

```bash
ssh -i "$AISEVAK_SSH_KEY" "$AISEVAK_SSH_USER@$AISEVAK_DEPLOY_HOST" \
  "sudo docker compose -p '$AISEVAK_COMPOSE_PROJECT' --env-file '$AISEVAK_ENV_FILE' -f '$AISEVAK_ACTIVE_RELEASE/docker-compose.yml' ps"
```

Follow API and web logs:

```bash
ssh -i "$AISEVAK_SSH_KEY" "$AISEVAK_SSH_USER@$AISEVAK_DEPLOY_HOST" \
  "sudo docker compose -p '$AISEVAK_COMPOSE_PROJECT' --env-file '$AISEVAK_ENV_FILE' -f '$AISEVAK_ACTIVE_RELEASE/docker-compose.yml' logs -f --tail=200 api web"
```

Inspect the host-native runner:

```bash
ssh -i "$AISEVAK_SSH_KEY" "$AISEVAK_SSH_USER@$AISEVAK_DEPLOY_HOST" \
  'sudo systemctl status aisevak-runner'
```

Inspect HTTPS proxy and certificate activity:

```bash
ssh -i "$AISEVAK_SSH_KEY" "$AISEVAK_SSH_USER@$AISEVAK_DEPLOY_HOST" \
  'sudo systemctl status caddy'
```

## Security notes

Aisevak is intended for a trusted small team. Worker runs use approvals-disabled, unrestricted execution, so keep the application on a dedicated VM, use a strong first-user password, and never expose SSH to unrestricted sources. Configure service credentials through the application UI rather than copying local authentication files to the VM.
