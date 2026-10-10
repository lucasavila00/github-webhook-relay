# Getting started

This guide connects one GitHub repository to one deployed relay. The relay uses
two hostnames in the same Cloudflare zone:

- `hooks.example.com` is public. GitHub sends signed requests only to
  `POST /webhooks/github` on this hostname.
- `relay.example.com` is private. Cloudflare Access protects the webapp,
  event history, and WebSocket stream on this hostname.

Replace both example hostnames with subdomains in your Cloudflare zone. Do not
deploy the example values.

## 1. Deploy the relay

Follow [Deployment](deployment.md). Complete the Worker custom domains,
Cloudflare Access application, email policy, service-token policy, Worker
variables, secret, and first deployment before you continue.

Open `https://relay.example.com` with your real relay hostname. Cloudflare
Access sends a one-time PIN to the email address in the Allow policy. After you
sign in, the event list opens.

## 2. Add the GitHub webhook

In the GitHub repository, select **Settings**, **Webhooks**, and **Add
webhook**. Enter these values:

| Field | Value |
| --- | --- |
| Payload URL | `https://hooks.example.com/webhooks/github` with your real webhook hostname |
| Content type | `application/json` |
| Secret | The same value that you entered for the Worker `WEBHOOK_SECRET` secret |
| Events | Select individual events: **Issues**, **Issue comments**, **Pull request review comments**, and **Pull requests** |
| Active | Selected |

The relay stores new issues, new issue and pull request conversation comments,
new inline pull request review comments, and merged pull requests. It ignores
other actions from the four selected GitHub event groups.

Select **Add webhook**. GitHub sends a `ping` delivery. A successful ping only
proves that GitHub can reach the public hostname. Create a test issue after the
webhook is active, then refresh the relay webapp and confirm that the issue
event is present.

The webhook hostname has no Cloudflare Access application or bypass policy.
The Worker verifies the GitHub HMAC signature before it stores a delivery.

## 3. Configure the local client

Create a Cloudflare Access service token and its Service Auth policy as
described in [Deployment](deployment.md). Set these values in the environment
that starts Codex:

```sh
export GH_WATCH_RELAY_URL=https://relay.example.com
export GH_WATCH_STATE_DIRECTORY=/home/user/.local/state/gh-watch
export CF_ACCESS_CLIENT_ID=your-service-token-client-id
export CF_ACCESS_CLIENT_SECRET=your-service-token-client-secret
```

Use your real relay hostname and a persistent, private directory. Cloudflare
shows the client secret only when it creates the service token.

From a checkout of this repository, install the plugin and start a new Codex
session:

```sh
codex plugin marketplace add /absolute/path/to/github-webhook-relay
codex plugin add gh-watch@github-webhook-relay
codex
```

In the new session, ask Codex to use `$gh-watch` with a stable consumer name,
the repository name, and one of these event types: `issues`, `issue_comment`,
`pull_request_review_comment`, or `pull_request`. The client connects outbound
to the Access-protected relay hostname. It stores each consumer cursor in the
state directory and resumes from that cursor after a restart.

For the full watch and acknowledgement contract, see the
[local client guide](local-client.md).

## 4. Check the complete path

Create a test issue in the configured GitHub repository. Confirm all of these
results:

1. The GitHub webhook delivery has a successful response.
2. The event appears in the webapp at your relay hostname.
3. A `gh-watch` call for the repository and `issues` event type returns the
   event.
4. After acknowledgement, the next call uses the saved cursor.

These checks use the real GitHub and Cloudflare services. Local and hosted
tests validate the source and runtime behavior, but they do not prove that
your provider configuration is correct.

## References

- [Creating GitHub webhooks](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)
- [Validating GitHub webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
