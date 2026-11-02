# Security Policy

## Reporting a Vulnerability

We take the security of this project seriously and welcome responsible disclosure of potential security vulnerabilities.

If you believe you have discovered a security vulnerability, please use GitHub's **Report a vulnerability** feature under the repository's **Security** tab.

Please do not disclose vulnerabilities through public GitHub issues, discussions, or pull requests.

Our security team will review submitted reports, assess their impact, and coordinate remediation as appropriate.

We appreciate the contributions of the security research community in helping us maintain a secure project.

## No transport encryption

This app has no TLS termination built in — it's plain HTTP, full stop. Anyone who can
observe traffic between a client and wherever this is running can read everything on the
wire, including the `STUDIO_API_TOKEN` bearer token if one is set. Binding to loopback
keeps that traffic on the machine itself; the moment `BIND_ADDRESS` (or an equivalent) puts
this on any network, even one you trust, that traffic is unencrypted on it. If you need to
reach this from another device, put a reverse proxy or a VPN in front of it that terminates
TLS — don't rely on the app for that, it doesn't do it.

Whether the port is reachable beyond your own network at all — firewall rules, port
forwarding, cloud security groups — is a deployment concern outside this app's own config.
The loopback-by-default binding is a safe starting point, not a guarantee of anything past
your own machine.

## Known risks accepted by design

These are real, reviewed, and left as-is on purpose rather than overlooked. All of them
assume the threat model this app is actually built for: a single operator, a trusted local
network, never the open internet. If that stops being true for your deployment, revisit
this list before you rely on any of it.

- **Catalog/images host paths can be pointed at any directory on the machine.**
  `POST /api/settings/host-paths` writes `CATALOG_HOST_PATH`/`IMAGES_HOST_PATH` to `.env`
  with no restriction on the value — by design, since pointing this at any local project's
  data is the feature's actual purpose, not an edge case to close off. That value becomes
  the Docker bind-mount source on the next container recreate. `GET /images/:filename`
  serves only image extensions (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`), so a mount
  pointed at, say, `~/.ssh` doesn't turn it into a download route for the keys in it —
  but the app can still write and delete image files in whatever directory is mounted.
  Reachable by anything that can reach `/api/*`. Don't widen `BIND_ADDRESS` beyond a
  network you'd trust with that.
- **Snapshot restore extracts a `.tar.gz` with no check on its contents**
  (`POST /:filename/restore`), which can overwrite application source or `.env`. There is no
  upload route for backups — the only way an untrusted archive reaches `data/backups/` is if
  you put it there yourself. Only restore snapshots from a source you trust, the same as
  you'd treat any other executable content.
- **Schema import (`POST /exports/schema-from-url`) feeds a fetched web page to the model
  unfenced.** A page designed to do so could influence what comes back. This only ever runs
  against a URL you supply — treat it like importing code from a URL, not like browsing.
- **Export zips can carry `../` in their internal paths** if `imageExportBase` (an
  operator-typed field on an export map) contains one. Only harms whoever extracts the zip —
  don't put `../` in that field, and be careful handing an export to someone else if you did.
- **The outbound-fetch SSRF guard doesn't cover every special-use IP range** (a handful of
  obscure ones — TEST-NET, benchmarking, multicast) and re-resolves the hostname separately
  at connect time, leaving a narrow DNS-rebinding window. The ranges that matter in practice
  — loopback, private, link-local, the cloud metadata address — are all covered.

## Supported versions

This is a prototype under active development on a single branch (`main`) — there is no
version-support matrix. Security fixes land on `main`; there are no backported patches to
older tags.
