# SQL Recipes

The error-tracker stores everything in your app's own database, in a table named `client_error`. The query API endpoint covers the common reads; SQL covers everything else. These recipes work from `psql`, the `sqlite3` shell, Drizzle Studio, or an AI coding assistant with database access.

## Before You Start

Column names are `snake_case` and all lowercase, so no identifier quoting is needed in either dialect.

Timestamps are the one place the two dialects differ:

- **Postgres:** `created_at`, `updated_at`, `last_seen_at`, `resolved_at` are `timestamp` columns. Compare them to timestamps and format them with the usual date functions.
- **SQLite:** the same four columns are integers holding milliseconds since the Unix epoch (Drizzle's `timestamp_ms` mode). Divide by 1000 before handing them to `datetime()`, and multiply by 1000 when comparing against `strftime('%s', ...)`.

Recipes that only select, filter on text, and order by a timestamp are identical in both. Recipes that compare or format a timestamp are given twice.

## Basic Queries

### Recent unresolved errors

Both dialects:

```sql
SELECT fingerprint, message, occurrences, environment, last_seen_at
FROM client_error
WHERE resolved_at IS NULL
ORDER BY last_seen_at DESC
LIMIT 20;
```

On SQLite, add a readable timestamp:

```sql
SELECT fingerprint, message, occurrences, environment,
       datetime(last_seen_at / 1000, 'unixepoch') AS last_seen
FROM client_error
WHERE resolved_at IS NULL
ORDER BY last_seen_at DESC
LIMIT 20;
```

### Errors seen since a deployment

There is one row per fingerprint for the life of the table, so `created_at` is the first time an error was ever seen. An error that existed months ago and recurred this morning keeps its original `created_at`. Filter on `last_seen_at` to find what is happening now, and on `created_at` to find what is new.

Postgres:

```sql
SELECT fingerprint, message, occurrences, created_at, last_seen_at
FROM client_error
WHERE last_seen_at >= TIMESTAMP '2026-03-15 00:00:00'
  AND resolved_at IS NULL
ORDER BY occurrences DESC;
```

SQLite:

```sql
SELECT fingerprint, message, occurrences,
       datetime(created_at / 1000, 'unixepoch') AS created,
       datetime(last_seen_at / 1000, 'unixepoch') AS last_seen
FROM client_error
WHERE last_seen_at >= strftime('%s', '2026-03-15 00:00:00') * 1000
  AND resolved_at IS NULL
ORDER BY occurrences DESC;
```

Swap `last_seen_at` for `created_at` in the `WHERE` clause to list only fingerprints the deployment introduced.

### Most frequent errors (top crashers)

Both dialects:

```sql
SELECT fingerprint, message, occurrences, environment
FROM client_error
WHERE resolved_at IS NULL
ORDER BY occurrences DESC
LIMIT 10;
```

### Error detail with full stack

Both dialects:

```sql
SELECT message, stack, resolved_stack, component_stack, url, user_agent,
       occurrences, environment, created_at, last_seen_at
FROM client_error
WHERE fingerprint = 'your-fingerprint-here';
```

## Filtering

### By environment

Both dialects:

```sql
SELECT * FROM client_error
WHERE environment = 'production'
  AND resolved_at IS NULL
ORDER BY last_seen_at DESC;
```

This one uses the `client_error_environment_idx` index.

### By URL pattern

Both dialects:

```sql
SELECT fingerprint, message, url, occurrences
FROM client_error
WHERE url LIKE '%/campaigns/%'
  AND resolved_at IS NULL
ORDER BY last_seen_at DESC;
```

`LIKE` is case-sensitive in Postgres and case-insensitive for ASCII in SQLite. Use `ILIKE` on Postgres if you want SQLite's behavior.

### By browser/user agent

Both dialects:

```sql
SELECT fingerprint, message, user_agent, occurrences
FROM client_error
WHERE user_agent LIKE '%Firefox%'
  AND resolved_at IS NULL;
```

## Aggregations

### Error count by environment

Both dialects:

```sql
SELECT environment,
       COUNT(*) AS error_count,
       SUM(occurrences) AS total_occurrences
FROM client_error
WHERE resolved_at IS NULL
GROUP BY environment;
```

### New errors per day (trend)

Postgres:

```sql
SELECT DATE(created_at) AS day,
       COUNT(*) AS new_errors,
       SUM(occurrences) AS total_hits
FROM client_error
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at)
ORDER BY day DESC;
```

SQLite:

```sql
SELECT date(created_at / 1000, 'unixepoch') AS day,
       COUNT(*) AS new_errors,
       SUM(occurrences) AS total_hits
FROM client_error
WHERE created_at >= (strftime('%s', 'now') - 30 * 86400) * 1000
GROUP BY day
ORDER BY day DESC;
```

`total_hits` is the lifetime occurrence count of the errors first seen that day, not the number of hits on that day. The table keeps a counter, not an event log.

### Top error pages

Both dialects:

```sql
SELECT url,
       COUNT(*) AS distinct_errors,
       SUM(occurrences) AS total_hits
FROM client_error
WHERE resolved_at IS NULL
  AND url IS NOT NULL
GROUP BY url
ORDER BY total_hits DESC
LIMIT 10;
```

## Maintenance

### Mark an error resolved

`npx error-tracker resolve <fingerprint>` does this and exits 1 if the fingerprint is unknown or already resolved. By hand:

Postgres:

```sql
UPDATE client_error
SET resolved_at = NOW()
WHERE fingerprint = 'your-fingerprint-here';
```

SQLite:

```sql
UPDATE client_error
SET resolved_at = strftime('%s', 'now') * 1000
WHERE fingerprint = 'your-fingerprint-here';
```

If the error happens again, ingestion clears `resolved_at` and the row returns to the unresolved list with its occurrence count and original `created_at` intact.

### Bulk resolve stale errors

Postgres:

```sql
UPDATE client_error
SET resolved_at = NOW()
WHERE resolved_at IS NULL
  AND last_seen_at < NOW() - INTERVAL '30 days';
```

SQLite:

```sql
UPDATE client_error
SET resolved_at = strftime('%s', 'now') * 1000
WHERE resolved_at IS NULL
  AND last_seen_at < (strftime('%s', 'now') - 30 * 86400) * 1000;
```

### Delete old resolved errors (cleanup)

Postgres:

```sql
DELETE FROM client_error
WHERE resolved_at IS NOT NULL
  AND resolved_at < NOW() - INTERVAL '90 days';
```

SQLite:

```sql
DELETE FROM client_error
WHERE resolved_at IS NOT NULL
  AND resolved_at < (strftime('%s', 'now') - 90 * 86400) * 1000;
```

Deleting a row throws away its history. If that error fires again, ingestion inserts a fresh row with `occurrences` at 1 and today's `created_at`.

### Table size check

Postgres:

```sql
SELECT COUNT(*) AS total_rows,
       COUNT(*) FILTER (WHERE resolved_at IS NULL) AS unresolved,
       COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved,
       pg_size_pretty(pg_total_relation_size('client_error')) AS table_size
FROM client_error;
```

SQLite (3.30 and later, which supports `FILTER`):

```sql
SELECT COUNT(*) AS total_rows,
       COUNT(*) FILTER (WHERE resolved_at IS NULL) AS unresolved,
       COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved
FROM client_error;
```

SQLite has no per-table size function in the default build. `PRAGMA page_count;` times `PRAGMA page_size;` gives the size of the whole database file.

## AI Assistant Usage

If you're using an AI coding assistant with database access, these prompts work well:

- "What are the top 5 errors in production right now?"
- "Show me errors on the /checkout page from the last 24 hours with their resolved stacks"
- "Which fingerprints were first seen since yesterday's deployment?"
- "Mark every error not seen in 2 weeks as resolved"

The `resolved_stack` column contains human-readable source locations when source map resolution is configured, so an assistant can read them directly to find where an error originates.
