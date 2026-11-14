# Deploy ScamShield

The production image serves the analyzer, the password-reset page, and the API from one origin. It runs as an unprivileged user and includes the trained model and PostgreSQL migrations. GitHub Actions builds the image and exercises it against PostgreSQL 17 and a test SMTP server on each pull request.

## Provision the environment

1. Create a PostgreSQL database and a database user with permission to apply the migrations. Enable backups and use the provider's TLS connection settings.
2. Set up SMTP and verify the sender address with your provider. Use their TLS endpoint and URL-encode any special characters in credentials.
3. Set up a public HTTPS domain and configure the host or reverse proxy to forward to port `3000`. Use a single app instance initially because rate limits are counted per process.
4. Set the following environment variables in your host's secret or configuration store. For Docker CLI deployments, supply the same variables in a private file outside the repository.

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` (set in the image) |
| `HOST` | `0.0.0.0` (set in the image) |
| `PORT` | `3000` by default. Match the host's routing and health check if you override it. |
| `DATABASE_URL` | Your PostgreSQL connection URL including the provider's TLS settings |
| `MAIL_TRANSPORT` | `smtp` |
| `SMTP_URL` | Your SMTP connection URL |
| `MAIL_FROM` | A sender your provider has verified, such as `ScamShield <no-reply@example.com>` |
| `PUBLIC_APP_URL` | The public HTTPS API origin, such as `https://scamshield.example.com`. It must serve or route both verification and reset links. |
| `CORS_ORIGINS` | Leave empty for the bundled frontend. For a separate frontend, list the exact allowed HTTPS origins, separated by commas. |
| `TRUST_PROXY` | Enable only when external traffic must pass through a trusted proxy that controls forwarded headers. |

The default frontend and ML settings can stay enabled. Keep `DB_AUTO_MIGRATE=false` and run migrations once per release. See [the environment template](../.env.example) for the remaining settings.

## Build and release

Configure hosted Docker platforms to build the root `Dockerfile` and run `npm run db:migrate` as a release job using the same environment as the service. Use `npm run db:seed` to install the starter article set. Both commands can be rerun after a successful release.

For a Docker host with an HTTPS reverse proxy on the same machine, run the following from the repository root. Replace `/secure/scamshield.env` with the private environment file. If the proxy runs in Docker, put the two containers on a private network and route to the app's container port.

```sh
docker build --pull -t scamshield:release .
docker run --rm --env-file /secure/scamshield.env scamshield:release npm run db:migrate
docker run --rm --env-file /secure/scamshield.env scamshield:release npm run db:seed
docker run -d --name scamshield --restart unless-stopped --env-file /secure/scamshield.env -p 127.0.0.1:3000:3000 scamshield:release
```

For a managed Node service without Docker, use Node.js 24 and run `npm ci --omit=dev`, the same release commands, and then `npm start`. Keep the source tree and the shipped model in the deployed checkout. Set `NODE_ENV` and `HOST` explicitly.

## Verify the deployed service

- Point the platform health check at `GET /api/health`. Through public HTTPS, it should return HTTP 200 with `status: "ok"` and `capabilities.ml: true` when the bundled classifier is enabled. HTTP 503 indicates the database probe failed.
- Open the analyzer and submit a test message. Verify the seeded articles via `GET /api/articles` if you ran the seed command.
- With a test account and your configured SMTP provider, check delivery of verification and reset emails. Open both public links and complete the reset. The bundled frontend has the reset page. Account registration, sign-in, and reset requests are available through the [auth API](API_DOCUMENTATION.md).
- Keep the previous image available for rollback. Database migrations are forward-only. Back up the database before applying a migration and confirm schema compatibility before rolling back application code.

## Vercel

Import the GitHub repository with the repository root as the Root Directory and use the settings from `vercel.json`. The Node.js function serves the allow-listed frontend and the API together. It uses the bundled classifier in-process, and migrations run as a separate release step.

When the PostgreSQL URL, SMTP URL, or sender address is missing, Vercel starts in analyzer-only mode. Visitors can scan text, links, and emails using the bundled model and rules. This mode has no accounts, scan history, screenshot OCR, or database access. `GET /api/health` reports the available capabilities.

Set `DATABASE_URL`, `MAIL_TRANSPORT=smtp`, `SMTP_URL`, `MAIL_FROM`, and `PUBLIC_APP_URL` in the Vercel project's Production environment. Use the project's public HTTPS domain for `PUBLIC_APP_URL`. Use the database provider's pooled endpoint for runtime traffic when available. Run `npm run db:migrate` against the production database from a trusted environment before serving traffic, and run `npm run db:seed` if you want the starter articles.

After configuring the project, redeploy and follow the verification steps above. If you enable OCR, use `OCR_CACHE_DIR=/tmp/tesseract` and set `UPLOAD_MAX_BYTES` below Vercel's 4.5 MB request limit to allow for multipart overhead. Rate limits are per instance. Use platform-level rate limits for limits that must apply across the whole deployment.
