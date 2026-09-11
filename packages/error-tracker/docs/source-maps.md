# Source Map Resolution

The error-tracker resolves minified production stack traces back to original source code on the server side. Source maps are read from the filesystem. They are never served publicly.

## How It Works

1. Client catches an error and sends the raw (minified) stack trace to `POST /api/errors`
2. The server's `createErrorHandlers` wrapper checks if `sourceMapDir` is configured
3. If configured, it reads each frame's file reference, finds the corresponding `.map` file, and uses the `source-map` npm package to resolve original file, line, and column
4. The resolved stack is stored in the `resolved_stack` column; the raw stack is preserved in `stack`
5. If resolution fails for any frame (missing map, corrupt file), the raw frame is kept

## Next.js Configuration

By default, Next.js does **not** generate source maps for production browser bundles. You must enable them:

```typescript
// next.config.ts
const nextConfig = {
  productionBrowserSourceMaps: true,
};

export default nextConfig;
```

This writes `.map` files alongside the JS chunks in `.next/static/chunks/`.

**Important:** This only affects the build output on disk. The `.map` files are **not** served as static assets unless you explicitly configure that. Don't: the error-tracker reads them from the filesystem instead.

## Server Configuration

Resolution is opt-in: pass `sourceMapDir` to `createErrorHandlers` to turn it on. When `sourceMapDir` is omitted, `createErrorHandlers`'s `POST` handler skips resolution entirely and stores the raw stack, so a default install never probes the filesystem on every report.

```ts
import { db, getDialect } from "@/db";

const handlers = createErrorHandlers({
  db,
  dialect: getDialect(),
  sourceMapDir: ".next/static/chunks",
});
```

For Next.js, set `sourceMapDir` to `.next/static/chunks`, the standard output directory for self-hosted deployments.

`resolveStack`, exported from `@context-kit/error-tracker/server` for calling directly, is different: when called without a directory argument, it defaults to `.next/static/chunks`. That default applies only to `resolveStack` itself, not to `createErrorHandlers`, which resolves nothing unless `sourceMapDir` is set.

## Deployment Requirements

Source map resolution requires that the `.next/` build output directory is present on the server at runtime. This is true for:

- **Self-hosted Node.js** (`next start`): the standard case
- **Docker deployments**: ensure the `.next/` directory is included in the image
- **PM2 / systemd deployments**: the app runs from the project directory

This does **not** work on:

- **Vercel Edge Runtime**: no filesystem access, so source maps cannot be read
- **Cloudflare Workers**: same limitation
- **Serverless functions** with stripped build artifacts: if `.next/static/` is not deployed, resolution is skipped

When source maps are unavailable, the error-tracker stores the raw minified stack trace and continues normally. No error is thrown.

## Caching

Parsed `SourceMapConsumer` instances are cached in memory (up to 20 entries, LRU eviction) to avoid re-reading and re-parsing the same `.map` files on repeated errors. This is important for error storms where the same source file produces many errors in quick succession.

Map files are read asynchronously. When several errors reference the same file at once and none of them has a cached entry yet, the loads are deduped: only one read of that file happens, and every caller waits on it rather than each issuing its own read. When a map file is missing, the resolver remembers that outcome and does not check the filesystem again for the same file on later errors, but that memory expires after 60 seconds so a map added by a later deploy gets picked up.

## File Resolution

The resolver extracts the filename from stack frame references, which can be:

- Absolute paths: `/app/.next/static/chunks/app-abc123.js`
- URLs: `http://localhost:3000/_next/static/chunks/app-abc123.js`

In both cases, the basename (`app-abc123.js`) is extracted and looked up as `{sourceMapDir}/app-abc123.js.map`.

Before that lookup touches the filesystem, the extracted basename is checked against `[\w.-]+\.js` (or `.mjs`). A name that doesn't match is skipped without a filesystem access.

## Troubleshooting

**Stacks are not resolved in production:**
1. Verify `productionBrowserSourceMaps: true` is in `next.config.ts`
2. Check that `.map` files exist: `ls .next/static/chunks/*.map`
3. Verify `sourceMapDir` matches your deployment layout
4. Check server logs for warnings during resolution

**Stacks resolve in dev but not production:**
- In development, Next.js includes inline source maps. The error-tracker doesn't need file-based resolution for dev builds. The `sourceMapDir` option is primarily for production.

**Resolution is slow:**
- First resolution for a given source map reads from disk. Subsequent resolutions use the in-memory cache. If you have many distinct source files, consider the cache limit (20 by default).
