# AWS access for the live Aisevak VM and agents

The live Aisevak VM is now an AWS EC2 instance. It supplies a default read-only AWS profile to trusted agent processes. External operators use AWS Systems Manager to inspect or open the VM; the old Azure VM and Azure public-IP bridge are no longer part of the production access path. A separate role profile provides deliberate, temporary Session Manager shell access to opted-in Embedr EC2 instances.

This document contains no credentials, account IDs, VM addresses, or instance IDs. Keep those values in the existing private deployment configuration and on the VM.

## Security model

- IAM user/profile `aisevak-reader`: resource metadata plus CloudWatch/log investigation; no AWS mutations.
- Role profile `embedr-ec2-shell`: one-hour STS sessions with `ssm:StartSession` only on the exact shared-worker and newsletter instance ARNs.
- No `ssm:SendCommand`, public SSH, EC2 key pair, or EC2 full-access policy.
- Session output streams to `/embedr/prod/ssm-sessions` and the session document enforces idle and absolute timeouts.
- `deepee-benchmark` is not in the role policy and must remain inaccessible to the shell profile.

An operating-system shell is not read-only. An agent using `embedr-ec2-shell` can alter the selected VM. Use that profile only when host-level investigation is necessary.

Agents run with unrestricted host access as the `aisevak` service user. Passing credential-file paths instead of secret environment variables prevents accidental environment dumps, but a trusted agent can still read the credential file. This is an intentional trust boundary of the live Aisevak VM.

## Connect to the live AWS VM

Load the sanitized private AWS deployment variables:

```bash
source "$HOME/Documents/aisevak-aws-deployment.env"
aws --profile "$AISEVAK_AWS_PROFILE" \
  --region "$AISEVAK_AWS_REGION" \
  ssm start-session \
  --target "$AISEVAK_INSTANCE_ID" \
  --document-name SSM-SessionManagerRunShell
```

The production hostname is https://aisevak.embedr.dev. Use the AWS EC2 instance ID from the private deployment file rather than a public Azure IP. If SSM reports the target offline, check the EC2 state, SSM Agent, and instance IAM role in AWS. Do not open SSH to the internet or route operations through the former Azure VM.

## VM prerequisites

The operator workstation needs AWS CLI v2 and the Session Manager plugin. The live EC2 VM also needs AWS CLI v2 when trusted agent processes perform AWS resource or log inspection.

```bash
aws --version
session-manager-plugin --version
```

If either command is absent, install it from the official AWS instructions before continuing:

- [Install AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- [Install the Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)

## Install the existing reader credential

The IAM access key already exists. Do not create another key unless performing an intentional rotation. Never paste the key into a command argument, Git file, terminal transcript, agent chat, or Aisevak database.

Create the persistent private directory, then use the interactive AWS configurator so the secret is not present in shell history:

```bash
sudo install -d -o aisevak -g aisevak -m 0700 /srv/aisevak/aws

sudo -u aisevak env \
  AWS_SHARED_CREDENTIALS_FILE=/srv/aisevak/aws/credentials \
  AWS_CONFIG_FILE=/srv/aisevak/aws/config \
  aws configure --profile aisevak-reader

sudo chmod 0600 /srv/aisevak/aws/credentials /srv/aisevak/aws/config
sudo chown aisevak:aisevak /srv/aisevak/aws/credentials /srv/aisevak/aws/config
```

Enter `us-east-1` as the default region and `json` as the output format. Use the existing `aisevak-observability-reader` access key and secret when prompted.

Configure role assumption after obtaining `aisevak_ec2_access_role_arn` from the Embedr production Terraform output:

```bash
role_arn='<terraform-output-aisevak_ec2_access_role_arn>'

sudo -u aisevak env \
  AWS_SHARED_CREDENTIALS_FILE=/srv/aisevak/aws/credentials \
  AWS_CONFIG_FILE=/srv/aisevak/aws/config \
  aws configure set role_arn "$role_arn" --profile embedr-ec2-shell
sudo -u aisevak env \
  AWS_SHARED_CREDENTIALS_FILE=/srv/aisevak/aws/credentials \
  AWS_CONFIG_FILE=/srv/aisevak/aws/config \
  aws configure set source_profile aisevak-reader --profile embedr-ec2-shell
sudo -u aisevak env \
  AWS_SHARED_CREDENTIALS_FILE=/srv/aisevak/aws/credentials \
  AWS_CONFIG_FILE=/srv/aisevak/aws/config \
  aws configure set role_session_name aisevak-agent --profile embedr-ec2-shell
sudo -u aisevak env \
  AWS_SHARED_CREDENTIALS_FILE=/srv/aisevak/aws/credentials \
  AWS_CONFIG_FILE=/srv/aisevak/aws/config \
  aws configure set duration_seconds 3600 --profile embedr-ec2-shell
sudo -u aisevak env \
  AWS_SHARED_CREDENTIALS_FILE=/srv/aisevak/aws/credentials \
  AWS_CONFIG_FILE=/srv/aisevak/aws/config \
  aws configure set region us-east-1 --profile embedr-ec2-shell
```

Do not display either file after configuration because the credentials file contains the long-lived secret.

## Expose only profile metadata to agent processes

Add these non-secret entries to `/opt/aisevak/.env` with `sudoedit`:

```dotenv
AWS_SHARED_CREDENTIALS_FILE=/srv/aisevak/aws/credentials
AWS_CONFIG_FILE=/srv/aisevak/aws/config
AWS_PROFILE=aisevak-reader
AWS_REGION=us-east-1
AWS_DEFAULT_REGION=us-east-1
AWS_PAGER=
```

Do not add `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or `AWS_SESSION_TOKEN` to the environment file. Deploy a release containing the runner allowlist change in this repository, then restart the runner:

```bash
sudo systemctl restart aisevak-runner
sudo systemctl status --no-pager aisevak-runner
```

## Verify access

Run as the same service user and with the same file paths as agents:

```bash
sudo -u aisevak env \
  AWS_SHARED_CREDENTIALS_FILE=/srv/aisevak/aws/credentials \
  AWS_CONFIG_FILE=/srv/aisevak/aws/config \
  AWS_PROFILE=aisevak-reader \
  AWS_REGION=us-east-1 \
  aws sts get-caller-identity

sudo -u aisevak env \
  AWS_SHARED_CREDENTIALS_FILE=/srv/aisevak/aws/credentials \
  AWS_CONFIG_FILE=/srv/aisevak/aws/config \
  AWS_PROFILE=aisevak-reader \
  AWS_REGION=us-east-1 \
  aws ec2 describe-instances \
    --query 'Reservations[].Instances[].{id:InstanceId,name:Tags[?Key==`Name`]|[0].Value,state:State.Name}'

sudo -u aisevak env \
  AWS_SHARED_CREDENTIALS_FILE=/srv/aisevak/aws/credentials \
  AWS_CONFIG_FILE=/srv/aisevak/aws/config \
  AWS_PROFILE=aisevak-reader \
  AWS_REGION=us-east-1 \
  aws logs describe-log-groups --query 'logGroups[].logGroupName'
```

The first command should identify `aisevak-observability-reader`. The resource and log commands should succeed. A mutating command such as `aws ec2 stop-instances` must be denied; do not test that denial against a real instance.

Before starting a shell, list and manually review eligible nodes:

```bash
AWS_PROFILE=aisevak-reader aws ec2 describe-instances \
  --region us-east-1 \
  --filters Name=tag:Name,Values=embedr-prod-shared-worker,embedr-newsletter Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].{id:InstanceId,name:Tags[?Key==`Name`]|[0].Value}'
```

Then use the separate role profile with the reviewed target:

```bash
AWS_PROFILE=embedr-ec2-shell aws ssm start-session \
  --region us-east-1 \
  --target '<reviewed-instance-id>' \
  --document-name SSM-SessionManagerRunShell
```

## Rotation and revocation

For rotation, create a second access key, configure it on the VM, verify all three read-only commands above, then deactivate and delete the old key. Never remove the working key before the replacement succeeds.

To revoke only shell access, remove the IAM user's role-assumption permission or remove the target instance ARN from the role policy. To revoke all AWS access, deactivate the IAM access key and stop the runner while investigating.
