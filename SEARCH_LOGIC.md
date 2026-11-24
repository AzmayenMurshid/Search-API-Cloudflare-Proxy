# Cloudflare Worker Search Logic

This document describes the current search flow in `cloudflare-worker/src/worker.js`.

## Endpoint

- Path: `/api/business-search`
- Method: `GET`
- Health check: `/health`

## How The Cloudflare Proxy Worker Works

The worker acts as a browser-safe proxy between the HubSpot module (or any frontend client) and the upstream business lookup API.

### Request lifecycle

1. Incoming request reaches Cloudflare Worker `fetch()`.
2. CORS headers are attached to every JSON response.
3. Route handling:
   - `OPTIONS` returns `204` for preflight requests.
   - `/health` returns a lightweight service health payload.
   - any route other than `/api/business-search` returns `404`.
4. For `/api/business-search`, the worker validates query text and forwards one upstream request.
5. The upstream response is normalized, filtered, deduplicated, and returned as clean JSON.

### Why this proxy exists

- Avoids direct browser dependency on upstream API details.
- Centralizes search cleanup and fuzzy matching logic in one place.
- Provides consistent error payloads to the frontend.
- Supports CORS safely from one controlled endpoint.

### CORS behavior

- Response header `Access-Control-Allow-Origin` uses `env.ALLOWED_ORIGIN` when set, otherwise `*`.
- Allowed methods: `GET, OPTIONS`.
- Allowed headers: `Content-Type, Authorization`.

### Upstream pass-through behavior

- The worker calls only:
  - `https://sbaexit.com/search_company23.php?company=<company>`
- It does not send a state parameter.
- It uses `accept: application/json, text/plain, */*`.

### Error and debug behavior

- Upstream network/HTTP failures return `502` with `Lookup unavailable`.
- Upstream payload-level `Error` values also return `502`.
- `debug=1` includes diagnostics such as upstream URL, response status, duration, and response preview.

## Request Input

The worker reads the company query from URL parameters in this order:

1. `company`
2. `query` (fallback if `company` is empty)

If the final company string is missing or fewer than 3 characters, the worker returns `400` with:

- `error: "Query too short"`
- `message: "Provide at least 3 characters."`

## Query Guard Policy

The worker now applies a conservative query guard before calling upstream.

### What it does

1. Trims leading and trailing whitespace.
2. Removes control characters.
3. Collapses repeated whitespace to a single space.
4. Applies a maximum query length of 120 characters.
5. Flags unsupported characters for policy review.

### Modes

- `QUERY_GUARD_MODE=monitor` (default): logs what would be blocked, but still processes the request.
- `QUERY_GUARD_MODE=enforce`: blocks flagged requests with `400` and a clear validation error.
- `QUERY_GUARD_MODE=off`: disables the guard policy.

### Validation response in enforce mode

When blocked, the worker returns:

```json
{
  "error": "Invalid query",
  "message": "Search query was blocked by input validation. Remove special characters and shorten the query to 120 characters or less.",
  "code": "QUERY_VALIDATION_FAILED",
  "details": ["..."]
}
```

### Logging

For flagged inputs, the worker writes a sanitized log event including:

- guard mode
- would-block vs blocked status
- reason codes
- input lengths
- sanitized previews

This supports monitor-first tuning before switching to enforce mode.

## Upstream Lookup

The worker performs a single upstream request to:

- `https://sbaexit.com/search_company23.php?company=<company>`

Important behavior:

- No state parameter is sent upstream.
- The worker does not iterate through state codes.

## Upstream Response Handling

1. If upstream HTTP status is not OK, worker returns `502` with `Lookup unavailable`.
2. If upstream payload contains an `Error` object/entry, worker returns `502`.
3. Otherwise, payload is converted into an item array from one of:
   - array payload itself
   - `payload.results`
   - `payload.data`
   - `payload.items`
   - fallback `[payload]`

## Result Normalization

Each item is normalized to:

- `id` (from `id`, `business_id`, `file_number`, or `name`)
- `name` (from common company-name fields)
- `status` (uppercased from `status` or `is_the_active_or_dissolved_`)

Only records with meaningful company-related fields are considered.

## Name Matching Rules

The worker uses fuzzy matching between upstream company names and the query:

1. Case-insensitive normalization (remove punctuation noise and collapse spaces)
2. Substring match (`name includes query` or vice versa)
3. Prefix match for short searches (for example, `Haf` -> `Hafeed Inc`)
4. Token-based partial matching (ignoring stop words like `inc`, `llc`, `company`)
5. Small typo tolerance using edit distance:
   - max distance `1` for medium tokens
   - max distance `2` for longer tokens

This allows partial and nearby matches such as:

- `Hafeed Inc`
- `Hafeed Ahmed Diner`
- similar close-name variants

## Deduplication

Normalized matches are deduplicated by an uppercase key composed of:

- `name`
- `state` (if present in item)
- `status`

## Response Shape

Success (`200`) returns:

```json
{
  "results": [
    {
      "id": "...",
      "name": "...",
      "status": "..."
    }
  ]
}
```

If `debug=1` is provided, debug metadata is included (upstream URL, status, duration, counts, and previews in error cases).
