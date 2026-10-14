# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a
vulnerability** on this repository. Do not open a public issue. Include the affected
component (scraper/worker, API, database, dashboard, CI) and steps to reproduce.

Please do not test against the production API beyond ordinary use, and never against
the athletics websites the scrapers read.

## Scope and design

The platform's security architecture, threat model, findings, tests and operational
runbook are in [`ncaa-soccer/docs/SECURITY.md`](ncaa-soccer/docs/SECURITY.md).

In short: the public API is read-only and rate-limited; ingestion can only be started
from the worker CLI by someone with Railway access; PostgreSQL has no public endpoint and
each service connects with its own least-privileged role; scraped content is treated as
untrusted (no execution, URL allowlist, SSRF guard); no secrets live in the repository,
CI or the browser bundle.
