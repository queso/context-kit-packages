#!/usr/bin/env node
// @context-kit/auth-ui CLI entry point

import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScaffoldOptions = {
  cwd: string;
  path?: string;
  providers?: string[];
  force?: boolean;
};

export type ScaffoldResult = {
  written: string[];
  skipped: string[];
  appDir: string;
};

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

type RouteDefinition = {
  file: string; // relative path like "sign-in/page.tsx"
  componentName: string; // export name from @context-kit/auth-ui
  supportsProviders: boolean;
};

const ROUTES: RouteDefinition[] = [
  { file: "sign-in/page.tsx", componentName: "SignInPage", supportsProviders: true },
  { file: "sign-up/page.tsx", componentName: "SignUpPage", supportsProviders: true },
  { file: "forgot-password/page.tsx", componentName: "ForgotPasswordPage", supportsProviders: false },
  { file: "reset-password/page.tsx", componentName: "ResetPasswordPage", supportsProviders: false },
  { file: "profile/page.tsx", componentName: "ProfilePage", supportsProviders: false },
  { file: "profile/password/page.tsx", componentName: "ProfilePasswordPage", supportsProviders: false },
  { file: "profile/sessions/page.tsx", componentName: "ProfileSessionsPage", supportsProviders: false },
];

// ---------------------------------------------------------------------------
// Template generation
// ---------------------------------------------------------------------------

function generateSimpleReExport(componentName: string): string {
  return `export { ${componentName} as default } from "@context-kit/auth-ui";\n`;
}

const VALID_PROVIDER_RE = /^[a-zA-Z0-9_-]+$/;

function generateWithProviders(componentName: string, providers: string[]): string {
  for (const p of providers) {
    if (!VALID_PROVIDER_RE.test(p)) {
      throw new Error(
        `Invalid provider name "${p}". Provider names must only contain letters, digits, hyphens, and underscores.`
      );
    }
  }
  const providerList = providers.map((p) => `"${p}"`).join(", ");
  return [
    `import { ${componentName} } from "@context-kit/auth-ui";`,
    ``,
    `export default function Page() {`,
    `  return <${componentName} providers={[${providerList}]} />;`,
    `}`,
    ``,
  ].join("\n");
}

function generateFileContent(
  route: RouteDefinition,
  providers: string[] | undefined
): string {
  if (route.supportsProviders && providers && providers.length > 0) {
    return generateWithProviders(route.componentName, providers);
  }
  return generateSimpleReExport(route.componentName);
}

// ---------------------------------------------------------------------------
// Core scaffold function
// ---------------------------------------------------------------------------

export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const { cwd, path: pathSegment, providers, force = false } = opts;

  // Validate package.json exists
  if (!existsSync(join(cwd, "package.json"))) {
    throw new Error(
      "Could not find package.json. Run this command from your project root."
    );
  }

  // Detect app directory: prefer app/ over src/app/
  let appDir: string;
  const appCandidate = join(cwd, "app");
  const srcAppCandidate = join(cwd, "src", "app");

  if (existsSync(appCandidate) && statSync(appCandidate).isDirectory()) {
    appDir = appCandidate;
  } else if (existsSync(srcAppCandidate) && statSync(srcAppCandidate).isDirectory()) {
    appDir = srcAppCandidate;
  } else {
    throw new Error(
      "Could not find your Next.js app directory. Run this command from your project root."
    );
  }

  const written: string[] = [];
  const skipped: string[] = [];

  for (const route of ROUTES) {
    const filePath = pathSegment
      ? join(appDir, pathSegment, route.file)
      : join(appDir, route.file);

    // Prevent path traversal: resolved path must remain within appDir
    const resolvedFilePath = resolve(filePath);
    const resolvedAppDir = resolve(appDir);
    if (!resolvedFilePath.startsWith(resolvedAppDir + "/") && resolvedFilePath !== resolvedAppDir) {
      throw new Error("Path must be within the app directory.");
    }

    // Skip existing files unless --force
    if (existsSync(filePath) && !force) {
      skipped.push(filePath);
      continue;
    }

    // Create directory if needed
    const dir = filePath.replace(/\/page\.tsx$/, "").replace(/\\page\.tsx$/, "");
    mkdirSync(dir, { recursive: true });

    // Write file
    const content = generateFileContent(route, providers);
    writeFileSync(filePath, content, "utf-8");
    written.push(filePath);
  }

  return { written, skipped, appDir };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  path?: string;
  providers?: string[];
  force: boolean;
  help: boolean;
} {
  const args = argv.slice(2); // remove node + script
  let path: string | undefined;
  let providers: string[] | undefined;
  let force = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--path" && args[i + 1]) {
      path = args[++i];
    } else if (arg === "--providers" && args[i + 1]) {
      providers = args[++i].split(",").map((p) => p.trim()).filter(Boolean);
    }
  }

  return { path, providers, force, help };
}

function printHelp(): void {
  console.log(`
Usage: npx @context-kit/auth-ui init [options]

Scaffolds auth route files into your Next.js app directory.

Options:
  --path <group>         Route group path (e.g. "(auth)")
  --providers <list>     Comma-separated OAuth providers (e.g. "google,github")
  --force                Overwrite existing files
  --help, -h             Show this help message

Example:
  npx @context-kit/auth-ui init
  npx @context-kit/auth-ui init --path "(auth)" --providers google,github
`);
}

// Run CLI only when this file is the entry point
if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("cli.ts") ||
    process.argv[1].endsWith("cli.js") ||
    process.argv[1].endsWith("auth-ui"))
) {
  const parsed = parseArgs(process.argv);

  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  scaffold({
    cwd: process.cwd(),
    path: parsed.path,
    providers: parsed.providers,
    force: parsed.force,
  })
    .then((result) => {
      if (result.written.length > 0) {
        console.log(`\nScaffolded ${result.written.length} file(s) into ${result.appDir}:`);
        for (const f of result.written) {
          console.log(`  ✓ ${f}`);
        }
      }
      if (result.skipped.length > 0) {
        console.log(`\nSkipped ${result.skipped.length} existing file(s) (use --force to overwrite):`);
        for (const f of result.skipped) {
          console.log(`  - ${f}`);
        }
      }
    })
    .catch((err: Error) => {
      console.error(`\nError: ${err.message}`);
      process.exit(1);
    });
}
