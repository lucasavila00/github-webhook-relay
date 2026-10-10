# Deployment

This deployment uses two Cloudflare Workers and two custom domains in the same
Cloudflare zone. The existing `github-webhook-relay` Worker owns the
`EVENT_RELAY` Durable Object, event history, and webapp. The small
`github-webhook-relay-ingress` Worker sends public webhook requests to that
same object. One hostname-scoped Cloudflare Access application protects the
relay hostname.

## Prerequisites

You need:

- Node.js 22 or later and pnpm 12;
- a Cloudflare account with Workers and Zero Trust enabled;
- one domain that is active in Cloudflare;
- permission to manage Workers, custom domains, and Access; and
- a GitHub repository where you can add a webhook.

Install the workspace dependencies and authenticate Wrangler:

```sh
pnpm install --frozen-lockfile
pnpm generate
pnpm --filter @github-webhook-relay/relay exec wrangler login
```

## 1. Choose the custom domains

Choose two unused subdomains in the same Cloudflare zone. This guide uses:

```text
hooks.example.com
relay.example.com
```

Use your real zone in all following values. Do not add a DNS record yourself.
Wrangler creates the records when it creates the Worker custom domains.

## 2. Configure Cloudflare Access

### Enable one-time PIN login

In the Cloudflare dashboard, go to **Zero Trust**, **Integrations**, and
**Identity providers**. Make sure **One-time PIN** is an enabled login method.
Cloudflare can send a PIN to an email address that an Access policy allows.

### Create the application and policies

Go to **Zero Trust**, **Access controls**, **Applications**, and select
**Create new application**. Select **Self-hosted and private**, then add a
public hostname with these values:

| Field | Value |
| --- | --- |
| Application name | `github-webhook-relay` |
| Subdomain | The read subdomain, such as `relay` |
| Domain | Your Cloudflare zone, such as `example.com` |
| Path | Leave empty |

Add an **Allow** policy. Under **Include**, select **Emails** and enter the
email address `lucaxx@gmail.com`. Select **One-time PIN** as the login method
for the application. Save the application.

Do not add the webhook hostname to this application. Do not create an Access
application for that hostname, a path bypass, an ingress application, or
Worker-level Access. Hostname-scoped Access supports the relay WebSocket and
does not cover the public webhook hostname.

Open the application again and select **Additional settings**. Copy the
**Application Audience (AUD) Tag**. Also copy your team domain from **Zero
Trust**, **Custom pages**, **Team name and domain**. The values have these
forms:

```text
ACCESS_AUD=your-application-audience-tag
ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
```

### Add service-token access

Go to **Zero Trust**, **Access controls**, **Service credentials**, **Service
Tokens**. Select **Create Service Token**, name it `gh-watch`, select its
duration, and generate it. Save the Client ID and Client Secret in your
credential manager. Cloudflare shows the secret one time.

Return to the `github-webhook-relay` Access application. Add a **Service Auth**
policy. Under **Include**, select **Service Token** and choose `gh-watch`. Keep
the Allow policy and the Service Auth policy on this one application. They are
separate policies because interactive email login and service-token login use
different Access decisions.

## 3. Configure Wrangler

Edit `packages/relay/wrangler.jsonc`. Set its custom domain and non-secret
variables to the real values from the prior steps:

```jsonc
{
  "workers_dev": false,
  "preview_urls": false,
  "routes": [
    { "pattern": "relay.example.com", "custom_domain": true }
  ],
  "vars": {
    "ACCESS_AUD": "your-application-audience-tag",
    "ACCESS_TEAM_DOMAIN": "https://your-team.cloudflareaccess.com"
  }
}
```

Edit `packages/relay/wrangler.ingress.jsonc` and set its custom domain to the
real webhook hostname:

```jsonc
{
  "name": "github-webhook-relay-ingress",
  "workers_dev": false,
  "preview_urls": false,
  "routes": [
    { "pattern": "hooks.example.com", "custom_domain": true }
  ],
  "durable_objects": {
    "bindings": [
      {
        "name": "EVENT_RELAY",
        "class_name": "EventRelay",
        "script_name": "github-webhook-relay"
      }
    ]
  }
}
```

Replace every example value before deployment. In the owner configuration,
keep the existing `EVENT_RELAY` binding and `v1` SQLite migration. In the
ingress configuration, keep `script_name` set to `github-webhook-relay`. These
settings connect both Workers to the existing Durable Object namespace and its
stored event history.

Create a high-entropy GitHub webhook secret and keep it in your credential
manager. You will set it after the first owner deployment and enter the same
value when you create the GitHub webhook. Do not put this value in
`wrangler.jsonc` or commit it.

## 4. Deploy

Build the webapp assets. Deploy the owner Worker first, then deploy the ingress
Worker from the repository root:

```sh
pnpm --filter @github-webhook-relay/webapp build
pnpm --filter @github-webhook-relay/relay exec wrangler deploy
pnpm --filter @github-webhook-relay/relay exec wrangler secret put WEBHOOK_SECRET
pnpm --filter @github-webhook-relay/relay exec wrangler deploy --config wrangler.ingress.jsonc
```

The owner must exist before Wrangler can bind the ingress Worker to its Durable
Object. It must also exist before Wrangler can set its secret. Wrangler prompts
for the secret value. Each deployment creates its custom-domain DNS record. In
**Workers & Pages**, open each Worker, then open **Settings**, **Domains &
Routes**. Confirm that each Worker has its expected custom domain and that
`workers.dev` and preview URLs are disabled.

The checked-in owner Worker name, `EVENT_RELAY` binding, external
`script_name`, and `v1` migration preserve the Durable Object namespace across
deployments. Use the same Cloudflare account and Worker names for later
deployments.

## 5. Validate the deployment boundary

Use the real hostnames in these checks:

```sh
curl -i https://hooks.example.com/
curl -i https://relay.example.com/
curl -i -X POST https://relay.example.com/webhooks/github
```

The webhook hostname root returns `404`. The relay hostname requires an Access
login. A webhook request to the relay hostname cannot ingest an event. A valid
GitHub delivery to `https://hooks.example.com/webhooks/github` succeeds only
when its HMAC signature matches `WEBHOOK_SECRET`.

Continue with [Getting started](getting-started.md) to create the GitHub
webhook, configure the local client, and run the first live end-to-end check.
Until those real-provider checks run with configured credentials, deployment
validation is pending. Source checks and hosted CI do not replace this proof.

## References

- Cloudflare Worker custom domains:
  https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Wrangler configuration:
  https://developers.cloudflare.com/workers/wrangler/configuration/
- Wrangler Durable Object bindings:
  https://developers.cloudflare.com/workers/wrangler/configuration/#durable-objects
- Cloudflare Access for a specific Worker hostname:
  https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- Cloudflare self-hosted applications:
  https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/
- Cloudflare Access service tokens:
  https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/
- Cloudflare Access JWT validation:
  https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
