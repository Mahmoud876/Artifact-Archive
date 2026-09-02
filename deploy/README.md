# Deploy Seshat on Google Compute Engine

This deployment runs the web application on a CPU VM and keeps provider keys, the administrator account, and session secrets on the VM. Caddy is the only public service and provides automatic HTTPS for `artifact-extractor.duckdns.org`.

## 1. Create the VM

In Google Cloud Console, create a Compute Engine VM with:

- Name: `seshat-prod`
- Region: `europe-west1` (choose any nearby region if preferred)
- Machine type: `e2-standard-2` (2 vCPU, 8 GB RAM)
- Boot disk: Ubuntu 24.04 LTS, 40 GB balanced persistent disk
- External IPv4: reserve a **static** address named `seshat-ip`
- Firewall: allow HTTP and HTTPS
- Do not create firewall rules for ports 3000 or 8788

The Google Cloud free trial restricts GPUs. This first deployment therefore uses the server-managed cloud analysis route and does not start the optional local detector.

Set a Cloud Billing budget alert before continuing. The Console shows the current estimate for the selected region and machine.

## 2. Point DuckDNS to the VM

In DuckDNS, replace the current IP for `artifact-extractor` with the VM's reserved external IPv4 and click **update ip**. A DuckDNS updater and token are unnecessary because the VM address is static.

Wait until this returns the VM address:

```bash
getent ahostsv4 artifact-extractor.duckdns.org
```

## 3. Install Node.js, Caddy, and the application

Open the VM's SSH terminal in Google Cloud Console and run:

```bash
sudo apt update
sudo apt install -y git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
rm /tmp/nodesource_setup.sh
sudo apt install -y nodejs

curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy

sudo useradd --system --home-dir /opt/seshat --shell /usr/sbin/nologin seshat
sudo install -d -o seshat -g seshat /opt/seshat
sudo -u seshat git clone https://github.com/Mahmoud876/Artifact-Archive.git /opt/seshat
sudo -u seshat npm --prefix /opt/seshat ci
sudo -u seshat npm --prefix /opt/seshat run build
sudo -u seshat mkdir -p /opt/seshat/data
```

## 4. Add private runtime configuration

```bash
sudo mkdir -p /etc/seshat
sudo install -m 0600 /opt/seshat/deploy/seshat.env.example /etc/seshat/seshat.env
sudoedit /etc/seshat/seshat.env
```

Enter the new Gemini key and, optionally, a new OpenRouter key. Never place keys in GitHub, shell history, screenshots, or chat.

Create the administrator with a new private production password:

```bash
cd /opt/seshat
read -rsp "New admin password: " SESHAT_ADMIN_PASSWORD; echo
sudo -u seshat env SESHAT_ADMIN_USERNAME="admin" SESHAT_ADMIN_PASSWORD="$SESHAT_ADMIN_PASSWORD" node tools/manage-admin.mjs
unset SESHAT_ADMIN_PASSWORD
```

To rename an existing administrator, provide the new username and the previous username in the same command. The account ID is preserved and the password is replaced:

```bash
cd /opt/seshat
read -rsp "New admin password: " SESHAT_ADMIN_PASSWORD; echo
sudo -u seshat env SESHAT_ADMIN_USERNAME="new-username" SESHAT_PREVIOUS_ADMIN_USERNAME="admin" SESHAT_ADMIN_PASSWORD="$SESHAT_ADMIN_PASSWORD" node tools/manage-admin.mjs
unset SESHAT_ADMIN_PASSWORD
```

Do not reuse `Admin123` on the public site.

## 5. Install and start the services

```bash
sudo install -m 0644 /opt/seshat/deploy/seshat.service /etc/systemd/system/seshat.service
sudo install -m 0644 /opt/seshat/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now seshat
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Verify locally on the VM, then through HTTPS:

```bash
curl -I http://127.0.0.1:3000
curl -I https://artifact-extractor.duckdns.org
sudo systemctl --no-pager --full status seshat caddy
```

## 6. Update and roll back

Before an update, record the current commit and back up the account file:

```bash
git -C /opt/seshat rev-parse HEAD
sudo install -D -m 0600 /opt/seshat/data/accounts.json /var/backups/seshat/accounts.json
```

Deploy an update:

```bash
sudo systemctl stop seshat
sudo -u seshat git -C /opt/seshat pull --ff-only
sudo -u seshat npm --prefix /opt/seshat ci
sudo -u seshat npm --prefix /opt/seshat run build
sudo systemctl start seshat
```

Rollback trigger: the login flow or extraction flow fails, HTTP 5xx responses persist, or response time becomes unusable after an update. Restore the recorded commit, rebuild, and restart `seshat`.

## Data note

Archive runs and crops are stored in each browser's IndexedDB and do not automatically move from `localhost` to the DuckDNS origin. Export any local collections that must be retained before switching users to the production address. The VM must retain and back up `data/accounts.json`.
