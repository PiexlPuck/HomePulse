# HomePulse Encrypted Update & CVE Push Daemon

Standalone host agent that collects OS package update counts (`apt`), kernel/reboot posture, and CVE findings, encrypts them with **AES-256-GCM**, signs the outer envelope with **Ed25519**, and pushes to `POST /api/v1/daemon/ingest`.

## Usage

1. Generate an Ed25519 keypair on the host:
   ```bash
   python3 daemon.py --generate-keys > keys.json
   ```
2. Enroll the host on HomePulse Core (`POST /api/v1/daemon/enroll` with `X-API-Key`) using `ed25519_public_key_b64` to obtain `kid` and `aes_key_b64`.
3. Collect and push encrypted posture (e.g. via systemd timer or `APT::Update::Post-Invoke` hook):
   ```bash
   python3 daemon.py --push --agent-id host:linux:node-01 --server-url https://homepulse.lan --kid <kid> --aes-key-b64 <aes_key_b64> --private-key-pem /etc/homepulse/agent.pem
   ```
