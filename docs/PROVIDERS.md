# Provider setup

ClaudeThing has one bounded display contract for quotas, identity, service
health, scalar metrics, cost, tokens, and daily metric history. Providers can
enter that contract in two ways:

- **Native collectors** authenticate locally and refresh automatically.
- **JSON bridge providers** read an owner-controlled local file. This is the
  safe, no-firmware-change path for provider APIs, CLIs, scripts, and agents.

The device never receives an API key, browser cookie, OAuth refresh token, or
password. Keep every credential in the provider's own CLI/keychain or in a
permission-restricted host environment/file.

## Enable a provider

Open the installed `dashboard-config.jsonc`:

- macOS: `~/Library/Application Support/CarThingCollector/dashboard-config.jsonc`
- Windows: `%LOCALAPPDATA%\CarThingCollector\dashboard-config.jsonc`

Remove the leading `//` from the desired provider row and save. The order of
enabled rows becomes the order on the device. Valid changes are picked up in
about five seconds; a bad edit leaves the last valid configuration running.

On an upgrade, the installer preserves that edited file exactly and writes the
latest complete template beside it as `dashboard-config.catalog.jsonc`. Copy
or uncomment new provider rows from the catalog file without losing existing
choices.

The `show` array selects lanes without inventing missing values:

- `quota`, `currentTokens`, `history`, and `cost`
- `identity` and `status`
- `metrics` for all scalar metrics, or `metric:<id>` for one
- `metricHistory` for provider-supplied daily charts

The details view paginates automatically when a provider has more data than
fits on one screen. Turn the dial to see every page.

## Native collectors

| Provider | Local authentication | Data surfaces |
| --- | --- | --- |
| Claude | Existing local Claude CLI sign-in and status line | current/weekly limits where available, reset times, local tokens/history |
| Codex | Existing local Codex app-server/CLI session | account-wide limits, reset credits, tokens/history, usage facts |
| Cursor | Existing Cursor desktop sign-in; optional `CLAUDETHING_CURSOR_COOKIE_FILE` | plan quotas, included/on-demand/API usage, costs, requests and 30-day history |
| Gemini | Existing Gemini CLI OAuth credentials | every quota bucket and account/tier identity exposed to that credential |
| Droid | `FACTORY_API_KEY`, `~/.factory/.env`, or a permission-restricted token/cookie file | 5-hour/weekly/monthly limits, core limits, extra usage and balances |
| Copilot | Existing `gh auth login`, `GH_TOKEN`, or a permission-restricted token file | chat/completion/premium quotas, credits, overage and plan identity |

Optional credential-file variables are
`CLAUDETHING_DROID_TOKEN_FILE`, `CLAUDETHING_DROID_COOKIE_FILE`, and
`CLAUDETHING_COPILOT_TOKEN_FILE`. Files should be readable only by the local
user. Provider endpoints and account tiers evolve; when a signed-in account
does not expose a requested surface, ClaudeThing shows a diagnostic rather
than a fabricated zero.

## Universal JSON bridge

For every bridge provider, write a complete `ProviderSnapshot` JSON object to:

- macOS: `~/Library/Application Support/CarThingCollector/providers/<id>.json`
- Windows: `%LOCALAPPDATA%\CarThingCollector\providers\<id>.json`

Write to a temporary file and rename it into place so the collector never
reads half a document. Files are capped at 2 MiB and fully validated. The
collector overrides `host` and `source` with trusted local values.

```json
{
  "id": "openrouter",
  "displayName": "OpenRouter",
  "state": "live",
  "observedAt": "2026-08-10T19:00:00.000Z",
  "source": null,
  "host": null,
  "quotaWindows": [
    {
      "id": "monthly_budget",
      "label": "Monthly budget",
      "usedPercent": 42.5,
      "resetsAt": "2026-09-01T00:00:00.000Z",
      "windowSeconds": 2678400
    }
  ],
  "tokens": null,
  "cost": {
    "amountUsd": 17.35,
    "isEstimate": true,
    "label": "Month-to-date estimate"
  },
  "identity": {
    "accountLabel": "Personal",
    "plan": "Pay as you go",
    "organization": null
  },
  "serviceStatus": {
    "state": "operational",
    "label": "Operational",
    "checkedAt": "2026-08-10T19:00:00.000Z"
  },
  "supplementalMetrics": [
    {
      "id": "creditsRemaining",
      "label": "Credits remaining",
      "value": 23.48,
      "unit": "usd",
      "periodLabel": "Current balance"
    },
    {
      "id": "requests",
      "label": "Requests",
      "value": 1820,
      "unit": "requests",
      "periodLabel": "This month",
      "limit": 5000,
      "remaining": 3180,
      "resetsAt": "2026-09-01T00:00:00.000Z"
    }
  ],
  "metricSeries": [
    {
      "id": "dailySpend",
      "label": "Daily spend",
      "unit": "usd",
      "periodLabel": "Last 7 days",
      "points": [
        { "date": "2026-08-09", "value": 1.82 },
        { "date": "2026-08-10", "value": 2.14 }
      ]
    }
  ],
  "diagnostic": null
}
```

Unknown values must be `null`, not zero. Percentages are `usedPercent` in the
range 0–100. Dates are UTC ISO instants; daily chart keys are `YYYY-MM-DD` in
ascending order. Supported scalar/chart units are `count`, `tokens`, `usd`,
`seconds`, `percent`, `credits`, `requests`, `characters`, `points`, and
`kwh`. Cost objects are deliberately labeled estimates because the display is
not an invoice.

## Included catalog

The [complete provider catalog](PROVIDER_CATALOG.md) gives every native and
bridge provider its own description. The checked-in config contains a disabled
stub for each entry.

An id not in that catalog also works through the bridge: add a config row with
a safe lowercase id and create the matching JSON file. This keeps the platform
extensible without shipping a new firmware image.
