# AWS deployment operations

This runbook is intentionally sanitized. AWS account IDs, instance IDs, public
IPs, usernames, and private-key locations stay in a local deployment file
rather than this repository.

Production runs on a dedicated AWS EC2 instance in ap-south-1. The public
application hostname is aisevak.embedr.dev, managed in Cloudflare. The
security group exposes only HTTP/HTTPS; SSH is not exposed publicly. Use AWS
Systems Manager (SSM) for host access, command execution, and inspection.

## Load the private deployment configuration

The private file is:

~~~text
$HOME/Documents/aisevak-aws-deployment.env
~~~

It defines the deployment URL and host values, including:

| Variable | Purpose |
| --- | --- |
| AISEVAK_APP_URL | Public URL, currently https://aisevak.embedr.dev |
| AISEVAK_PUBLIC_HOST | Hostname used by Cloudflare and Caddy |
| AISEVAK_AWS_REGION | AWS region containing the EC2 instance |
| AISEVAK_AWS_PROFILE | Local AWS profile with SSM operator permissions |
| AISEVAK_INSTANCE_ID | Production EC2 instance ID |
| AISEVAK_INSTANCE_NAME | Production EC2 Name tag |
| AISEVAK_PUBLIC_IP | Current AWS public IP for diagnostics |
| AISEVAK_SSM_DOCUMENT | Normally AWS-RunShellScript |
| AISEVAK_SSM_LOCAL_PORT | Local port for optional SSM SSH forwarding |
| AISEVAK_SSH_USER | Linux user used only inside that tunnel |
| AISEVAK_SSH_KEY | Local key used only inside that tunnel |
| AISEVAK_LOCAL_REPO | Local source checkout |
| AISEVAK_REMOTE_SOURCE | Source staging directory on the EC2 instance |
| AISEVAK_ACTIVE_RELEASE | Active release directory |
| AISEVAK_ENV_FILE | Production environment file |
| AISEVAK_BACKUP_DIR | Database backup directory |
| AISEVAK_COMPOSE_PROJECT | Docker Compose project name |
| AISEVAK_CADDYFILE | Local private Caddy configuration |

Load it before running commands:

~~~bash
source "$HOME/Documents/aisevak-aws-deployment.env"
~~~

Never copy this file, the Caddy configuration, the SSH private key, or the
production environment file into the repository.

## Confirm access and instance health

~~~bash
aws --profile "$AISEVAK_AWS_PROFILE" sts get-caller-identity

aws --profile "$AISEVAK_AWS_PROFILE" \
  --region "$AISEVAK_AWS_REGION" \
  ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=$AISEVAK_INSTANCE_ID"
~~~

The instance should report Online. If it is offline, check the EC2 state, SSM
Agent, and instance IAM role in AWS. Do not fall back to the former Azure VM or
open public SSH.

## Connect to the VM

Use Session Manager for an interactive host shell:

~~~bash
aws --profile "$AISEVAK_AWS_PROFILE" \
  --region "$AISEVAK_AWS_REGION" \
  ssm start-session \
  --target "$AISEVAK_INSTANCE_ID" \
  --document-name SSM-SessionManagerRunShell
~~~

The application runs from /opt/aisevak/current. Persistent workspaces and AWS
credential files live under /srv/aisevak.

For non-interactive operations, use Systems Manager → Run Command →
AWS-RunShellScript, select the production instance, and inspect the output:

~~~bash
COMMAND_ID="$(
  aws --profile "$AISEVAK_AWS_PROFILE" \
    --region "$AISEVAK_AWS_REGION" \
    ssm send-command \
    --document-name "$AISEVAK_SSM_DOCUMENT" \
    --instance-ids "$AISEVAK_INSTANCE_ID" \
    --parameters 'commands=["sudo systemctl is-active caddy"]' \
    --comment "Check Aisevak Caddy" \
    --query 'Command.CommandId' \
    --output text
)"

aws --profile "$AISEVAK_AWS_PROFILE" \
  --region "$AISEVAK_AWS_REGION" \
  ssm get-command-invocation \
  --command-id "$COMMAND_ID" \
  --instance-id "$AISEVAK_INSTANCE_ID"
~~~

## Deploy an update

Inspect the local checkout first:

~~~bash
cd "$AISEVAK_LOCAL_REPO"
git status --short --branch
~~~

The migrated AWS VM keeps releases under /opt/aisevak/current; it is not a Git
checkout. Stage the local checkout through an SSM SSH port-forward. Start the
forward in one terminal:

~~~bash
aws --profile "$AISEVAK_AWS_PROFILE" \
  --region "$AISEVAK_AWS_REGION" \
  ssm start-session \
  --target "$AISEVAK_INSTANCE_ID" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=localhost,portNumber=22,localPortNumber=$AISEVAK_SSM_LOCAL_PORT"
~~~

In a second terminal, copy the release source through the tunnel:

~~~bash
rsync -az --delete \
  --exclude='.git/' --exclude='.env' --exclude='.env.local' \
  --exclude='.aisevak-dev/' --exclude='.aisevak-managed/' \
  --exclude='data/' --exclude='tmp/' --exclude='node_modules/' \
  --exclude='dist/' --exclude='coverage/' \
  -e "ssh -p $AISEVAK_SSM_LOCAL_PORT -i $AISEVAK_SSH_KEY -o StrictHostKeyChecking=no" \
  "$AISEVAK_LOCAL_REPO/" \
  "$AISEVAK_SSH_USER@127.0.0.1:$AISEVAK_REMOTE_SOURCE/"
~~~

Then run through Run Command:

~~~bash
cd "$AISEVAK_REMOTE_SOURCE"
sudo ./scripts/install.sh
~~~

The installer builds before activation, preserves the production environment,
persistent data, and the PostgreSQL volume, creates a backup before restarting
services, and aborts before activation if a required database migration fails.

## Update Caddy

Stage the private Caddy file through the SSM tunnel:

~~~bash
scp -P "$AISEVAK_SSM_LOCAL_PORT" -i "$AISEVAK_SSH_KEY" \
  -o StrictHostKeyChecking=no "$AISEVAK_CADDYFILE" \
  "$AISEVAK_SSH_USER@127.0.0.1:/tmp/aisevak-Caddyfile"
~~~

Then run:

~~~bash
sudo install -m 0644 /tmp/aisevak-Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
~~~

The active site should use aisevak.embedr.dev and reverse proxy to
127.0.0.1:8080. Cloudflare owns the DNS record and proxy. Do not use the
former Azure cloudapp.azure.com hostname or expose port 22.

## Verify and operate

~~~bash
curl -fsS "$AISEVAK_APP_URL/api/health"
curl -fsSI "$AISEVAK_APP_URL/"
~~~

The API health response is {"ok":true}; public web traffic must succeed over
HTTPS. Run these commands through SSM for host-side checks:

~~~bash
sudo docker compose -p "$AISEVAK_COMPOSE_PROJECT" \
  --env-file "$AISEVAK_ENV_FILE" \
  -f "$AISEVAK_ACTIVE_RELEASE/docker-compose.yml" ps
sudo docker compose -p "$AISEVAK_COMPOSE_PROJECT" \
  --env-file "$AISEVAK_ENV_FILE" \
  -f "$AISEVAK_ACTIVE_RELEASE/docker-compose.yml" logs --tail=200 api web
sudo docker exec current-postgres-1 pg_isready -U aisevak -d aisevak
sudo systemctl status --no-pager aisevak-runner
sudo systemctl status --no-pager caddy
sudo journalctl -u caddy --since "30 minutes ago" --no-pager
~~~

For AWS resource, CloudWatch, log, or controlled EC2 access from trusted
agents, follow [AWS access for live Aisevak agents](AWS_ACCESS.md). AWS
credentials remain in /srv/aisevak/aws and are never included in releases.

## Security notes

Aisevak is intended for a trusted small team. Keep it on a dedicated EC2
instance, use a strong first-user password, never expose SSH to unrestricted
sources, and use SSM for operations. Configure service credentials through the
application UI rather than copying local authentication files to the VM.
