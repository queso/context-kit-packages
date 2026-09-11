# SQL Recipes

The error-tracker stores everything in your app's own Postgres database. The query API endpoint is a convenience — the real interface is SQL. These recipes work with any Postgres client, `psql`, or an AI coding assistant with database access.

## Basic Queries

### Recent unresolved errors

```sql
SELECT fingerprint, message, occurrences, environment, "lastSeenAt"
FROM "ClientError"
WHERE "resolvedAt" IS NULL
ORDER BY "lastSeenAt" DESC
LIMIT 20;
```

### Errors introduced after a deployment

```sql
SELECT fingerprint, message, occurrences, "createdAt"
FROM "ClientError"
WHERE "createdAt" >= '2024-03-15T00:00:00Z'
  AND "resolvedAt" IS NULL
ORDER BY occurrences DESC;
```

### Most frequent errors (top crashers)

```sql
SELECT fingerprint, message, occurrences, environment
FROM "ClientError"
WHERE "resolvedAt" IS NULL
ORDER BY occurrences DESC
LIMIT 10;
```

### Error detail with full stack

```sql
SELECT message, stack, "resolvedStack", "componentStack", url, "userAgent",
       occurrences, environment, "createdAt", "lastSeenAt"
FROM "ClientError"
WHERE fingerprint = 'your-fingerprint-here';
```

## Filtering

### By environment

```sql
SELECT * FROM "ClientError"
WHERE environment = 'production'
  AND "resolvedAt" IS NULL
ORDER BY "lastSeenAt" DESC;
```

### By URL pattern

```sql
SELECT fingerprint, message, url, occurrences
FROM "ClientError"
WHERE url LIKE '%/campaigns/%'
  AND "resolvedAt" IS NULL
ORDER BY "lastSeenAt" DESC;
```

### By browser/user agent

```sql
SELECT fingerprint, message, "userAgent", occurrences
FROM "ClientError"
WHERE "userAgent" LIKE '%Firefox%'
  AND "resolvedAt" IS NULL;
```

## Aggregations

### Error count by environment

```sql
SELECT environment, COUNT(*) as error_count, SUM(occurrences) as total_occurrences
FROM "ClientError"
WHERE "resolvedAt" IS NULL
GROUP BY environment;
```

### Errors per day (trend)

```sql
SELECT DATE("createdAt") as day, COUNT(*) as new_errors, SUM(occurrences) as total_hits
FROM "ClientError"
WHERE "createdAt" >= NOW() - INTERVAL '30 days'
GROUP BY DATE("createdAt")
ORDER BY day DESC;
```

### Top error pages

```sql
SELECT url, COUNT(*) as distinct_errors, SUM(occurrences) as total_hits
FROM "ClientError"
WHERE "resolvedAt" IS NULL
  AND url IS NOT NULL
GROUP BY url
ORDER BY total_hits DESC
LIMIT 10;
```

## Maintenance

### Mark an error resolved

```sql
UPDATE "ClientError"
SET "resolvedAt" = NOW()
WHERE fingerprint = 'your-fingerprint-here';
```

### Bulk resolve old errors

```sql
UPDATE "ClientError"
SET "resolvedAt" = NOW()
WHERE "resolvedAt" IS NULL
  AND "lastSeenAt" < NOW() - INTERVAL '30 days';
```

### Delete old resolved errors (cleanup)

```sql
DELETE FROM "ClientError"
WHERE "resolvedAt" IS NOT NULL
  AND "resolvedAt" < NOW() - INTERVAL '90 days';
```

### Table size check

```sql
SELECT COUNT(*) as total_rows,
       COUNT(*) FILTER (WHERE "resolvedAt" IS NULL) as unresolved,
       COUNT(*) FILTER (WHERE "resolvedAt" IS NOT NULL) as resolved,
       pg_size_pretty(pg_total_relation_size('"ClientError"')) as table_size
FROM "ClientError";
```

## AI Assistant Usage

If you're using an AI coding assistant with database access, these prompts work well:

- "What are the top 5 errors in production right now?"
- "Show me errors on the /checkout page from the last 24 hours with their resolved stacks"
- "How many new errors were introduced since yesterday's deployment?"
- "Mark all errors older than 2 weeks as resolved"

The `resolvedStack` column contains human-readable source locations when source map resolution is configured — AI assistants can read these directly to understand where errors originate.
