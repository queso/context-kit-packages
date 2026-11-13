#!/usr/bin/env bun
// Packs each package the way a release does, installs every tarball into an empty
// project with `bun add`, imports each entry in the package's `exports` map, and
// typechecks those imports against TypeScript 7. Run after `bun run build`.
//
//   bun scripts/pack-check.ts                     # every package under packages/
//   bun scripts/pack-check.ts error-tracker       # one package (by directory name)
//
// Env:
//   PACK_CHECK_TS_VERSION  TypeScript version for the consumer typecheck (default "7")
//   PACK_CHECK_OUT         keep tarballs and the consumer project here instead of a temp dir

import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const root = resolve(import.meta.dir, "..");
const tsVersion = process.env.PACK_CHECK_TS_VERSION ?? "7";
const out = process.env.PACK_CHECK_OUT
  ? resolve(process.env.PACK_CHECK_OUT)
  : mkdtempSync(join(tmpdir(), "pack-check-"));
mkdirSync(out, { recursive: true });

type PackageJson = {
  name: string;
  version: string;
  private?: boolean;
  exports?: Record<string, string | Record<string, string>>;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type Packed = { dir: string; pkg: PackageJson; tarball: string; files: string[] };

const failures: string[] = [];
function fail(pkg: string, message: string) {
  failures.push(`${pkg}: ${message}`);
  console.error(`  FAIL ${message}`);
}

// Files every tarball must contain, and the only files outside dist/ it may contain.
const REQUIRED_FILES = ["package.json", "README.md", "CHANGELOG.md", "LICENSE"];

const allDirs = readdirSync(join(root, "packages"))
  .filter((d) => existsSync(join(root, "packages", d, "package.json")))
  .sort();
const requested = process.argv.slice(2);
for (const name of requested) {
  if (!allDirs.includes(name)) {
    console.error(`Unknown package directory: ${name} (have: ${allDirs.join(", ")})`);
    process.exit(2);
  }
}

// Pack every package, not just the requested ones: a requested package may need a
// sibling's tarball to satisfy an @context-kit/* dependency.
const packed = new Map<string, Packed>();
const tarballDir = join(out, "tarballs");
mkdirSync(tarballDir, { recursive: true });

for (const dir of allDirs) {
  const pkgDir = join(root, "packages", dir);
  const pkg: PackageJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  if (pkg.private) continue;

  await $`bun pm pack --destination ${tarballDir} --quiet`.cwd(pkgDir).quiet();
  const tarball = join(tarballDir, `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`);
  if (!existsSync(tarball)) {
    console.error(`bun pm pack did not produce ${tarball}`);
    process.exit(1);
  }
  const files = (await $`tar -tzf ${tarball}`.text())
    .split("\n")
    .filter((f) => f && !f.endsWith("/"))
    .map((f) => f.replace(/^package\//, ""));
  packed.set(pkg.name, { dir, pkg, tarball, files });
}

const targets = [...packed.values()].filter((p) => requested.length === 0 || requested.includes(p.dir));

for (const { dir, pkg, tarball, files } of targets) {
  console.log(`\n== ${pkg.name}@${pkg.version} (${tarball})`);

  // 1. Tarball contents: dist plus the required files, nothing else.
  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) fail(pkg.name, `tarball is missing ${required}`);
  }
  if (!files.some((f) => f.startsWith("dist/"))) fail(pkg.name, "tarball has no dist/ files");
  for (const f of files) {
    if (!f.startsWith("dist/") && !REQUIRED_FILES.includes(f)) {
      fail(pkg.name, `tarball contains ${f}, which is outside dist/ and the required files`);
    }
  }

  // 1b. The README's install line names this version's release tarball.
  const tarballName = tarball.split("/").pop();
  const installUrl = `https://github.com/queso/context-kit-packages/releases/download/${dir}-v${pkg.version}/${tarballName}`;
  if (!readFileSync(join(root, "packages", dir, "README.md"), "utf8").includes(installUrl)) {
    fail(pkg.name, `README.md does not contain the install URL for this version: ${installUrl}`);
  }

  // 2. The packed package.json, which is what the consumer sees.
  const packedPkg: PackageJson = JSON.parse(await $`tar -xzOf ${tarball} package/package.json`.text());
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"] as const) {
    for (const [dep, range] of Object.entries(packedPkg[field] ?? {})) {
      if (range.startsWith("workspace:")) {
        fail(pkg.name, `packed package.json has ${field}.${dep} = "${range}"`);
      }
    }
  }

  // 3. Every exports and bin target is in the tarball.
  const exportEntries = Object.entries(packedPkg.exports ?? {});
  if (exportEntries.length === 0) fail(pkg.name, "packed package.json has no exports map");
  for (const [subpath, target] of exportEntries) {
    const conditions = typeof target === "string" ? { default: target } : target;
    for (const [condition, path] of Object.entries(conditions)) {
      if (!files.includes(path.replace(/^\.\//, ""))) {
        fail(pkg.name, `exports["${subpath}"].${condition} points at ${path}, which is not in the tarball`);
      }
    }
  }
  const bins = typeof packedPkg.bin === "string" ? { [pkg.name]: packedPkg.bin } : (packedPkg.bin ?? {});
  for (const [bin, path] of Object.entries(bins)) {
    if (!files.includes(path.replace(/^\.\//, ""))) fail(pkg.name, `bin "${bin}" points at ${path}, which is not in the tarball`);
  }

  // 4. Install into an empty project with `bun add`. Sibling @context-kit/* packages
  //    the tarball depends on (as a dependency or a peer) come from their own tarballs,
  //    because none is on a registry. Bun resolves a peer against the registry even when
  //    a tarball of it is installed, so the consumer pins each sibling with `overrides`,
  //    which is what the READMEs tell consumers to do.
  const consumer = join(out, `consumer-${dir}`);
  await $`rm -rf ${consumer}`.quiet();
  mkdirSync(consumer, { recursive: true });
  const siblings: Record<string, string> = {};
  for (const field of ["dependencies", "peerDependencies"] as const) {
    for (const dep of Object.keys(packedPkg[field] ?? {})) {
      if (!dep.startsWith("@context-kit/")) continue;
      const sibling = packed.get(dep);
      if (sibling) siblings[dep] = sibling.tarball;
      else fail(pkg.name, `${field}.${dep} has no package in this repo to install it from`);
    }
  }
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        name: `pack-check-${dir}`,
        private: true,
        type: "module",
        ...(Object.keys(siblings).length > 0 ? { overrides: siblings } : {}),
      },
      null,
      2,
    ),
  );
  const install = await $`bun add ${tarball} ${Object.values(siblings)}`.cwd(consumer).nothrow().quiet();
  if (install.exitCode !== 0) {
    fail(pkg.name, `bun add failed:\n${install.stderr.toString()}${install.stdout.toString()}`);
    continue;
  }
  console.log(`  ok   bun add ${[tarball, ...Object.values(siblings)].map((t) => t.split("/").pop()).join(" ")}`);

  // Bun installs required peers on its own but skips optional ones. Add every declared
  // peer, so each entry has everything the package declares and nothing it does not.
  // An entry that needs an undeclared package fails its import below.
  const peerSpecs = Object.entries(packedPkg.peerDependencies ?? {})
    .filter(([dep]) => !dep.startsWith("@context-kit/"))
    .map(([dep, range]) => `${dep}@${range}`);
  if (peerSpecs.length > 0) {
    const peers = await $`bun add ${peerSpecs}`.cwd(consumer).nothrow().quiet();
    if (peers.exitCode !== 0) {
      fail(pkg.name, `installing peers failed:\n${peers.stderr.toString()}`);
      continue;
    }
  }

  // 5. Import each entry at runtime with Bun and with Node, one process per entry so a
  //    failure names it. `next` has no exports map, so plain Node cannot resolve a bare
  //    `next/headers`-style import; inside a Next.js app those imports go through Next's
  //    bundler. That one Node failure is reported, not failed on.
  const specifiers = exportEntries.map(([subpath]) => (subpath === "." ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//, "")}`));
  for (const spec of specifiers) {
    const file = join(consumer, "import-check.mjs");
    writeFileSync(
      file,
      `const m = await import(${JSON.stringify(spec)});\n` +
        `if (Object.keys(m).length === 0) throw new Error("no exports");\n` +
        `console.log(${JSON.stringify(spec)} + ": " + Object.keys(m).length + " exports");\n`,
    );
    for (const runtime of ["bun", "node"]) {
      const run = await $`${runtime} ${file}`.cwd(consumer).nothrow().quiet();
      const stderr = run.stderr.toString();
      const nextSubpath = stderr.match(/ERR_MODULE_NOT_FOUND\]: Cannot find module '[^']*\/node_modules\/(next\/[^'/]+)'/)?.[1];
      if (run.exitCode === 0) console.log(`  ok   import (${runtime}) ${run.stdout.toString().trim()}`);
      else if (runtime === "node" && nextSubpath) {
        console.log(`  warn import (node) ${spec}: plain Node cannot resolve ${nextSubpath}; Next.js resolves it when it bundles the app`);
      } else fail(pkg.name, `import "${spec}" with ${runtime} failed:\n${stderr}`);
    }
  }

  // 6. Typecheck the same imports against TypeScript 7 with library checking on, so
  //    errors inside the packed .d.ts files are reported. The compiler options follow a
  //    Next.js app (oktomerge's tsconfig) apart from skipLibCheck. Errors in other
  //    packages' .d.ts files are counted and printed, not failed on: this repo cannot
  //    fix them, and a consumer with skipLibCheck on never sees them.
  const tsInstall =
    await $`bun add -d typescript@${tsVersion} @types/react @types/react-dom @types/node @types/bun`.cwd(consumer).nothrow().quiet();
  if (tsInstall.exitCode !== 0) {
    fail(pkg.name, `installing typescript@${tsVersion} failed:\n${tsInstall.stderr.toString()}`);
    continue;
  }
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2017",
          lib: ["dom", "dom.iterable", "esnext"],
          module: "esnext",
          moduleResolution: "bundler",
          esModuleInterop: true,
          isolatedModules: true,
          jsx: "react-jsx",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ["bun", "node"],
        },
        include: ["types-check.ts"],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(consumer, "types-check.ts"),
    specifiers.map((spec, i) => `import * as m${i} from ${JSON.stringify(spec)};\nvoid m${i};\n`).join(""),
  );
  const tscVersion = (await $`./node_modules/.bin/tsc --version`.cwd(consumer).nothrow().text()).trim();
  const tsc = await $`./node_modules/.bin/tsc -p tsconfig.json --pretty false`.cwd(consumer).nothrow().quiet();
  const ours: string[] = [];
  const theirs: string[] = [];
  for (const line of `${tsc.stdout}${tsc.stderr}`.split("\n")) {
    if (!/^\S.*: error TS\d+:/.test(line)) {
      if (line.trim() && ours.length > 0 && !/^\S/.test(line)) ours[ours.length - 1] += `\n${line}`;
      continue;
    }
    if (line.startsWith("types-check.ts") || line.startsWith(`node_modules/${pkg.name}/`)) ours.push(line);
    else theirs.push(line);
  }
  if (tsc.exitCode !== 0 && ours.length === 0 && theirs.length === 0) {
    fail(pkg.name, `tsc exited ${tsc.exitCode} under ${tscVersion} without reporting an error:\n${tsc.stdout}${tsc.stderr}`);
  } else if (ours.length > 0) {
    fail(pkg.name, `types failed under ${tscVersion}:\n${ours.join("\n")}`);
  } else {
    console.log(`  ok   types (${tscVersion}, ${specifiers.length} entries)`);
  }
  if (theirs.length > 0) {
    const byPackage = new Map<string, number>();
    for (const line of theirs) {
      const name = line.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1] ?? line.split("(")[0];
      byPackage.set(name, (byPackage.get(name) ?? 0) + 1);
    }
    const summary = [...byPackage].map(([name, n]) => `${name} (${n})`).join(", ");
    console.log(`  warn ${theirs.length} error(s) in other packages' .d.ts files under ${tscVersion}, not failed on: ${summary}`);
  }
}

if (failures.length > 0) {
  console.error(`\npack-check: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`- ${f.split("\n")[0]}`);
  process.exit(1);
}
console.log(`\npack-check: ${targets.length} package(s) ok (output in ${out})`);
