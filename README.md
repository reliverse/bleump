# 🪸 bleump • powerful version bumping

> Need a hassle-free way to bump versions across your JS/TS project? `@reliverse/bleump` has got you covered! It's available both as a CLI tool and a library.

[![📦 npm](https://img.shields.io/npm/v/@reliverse/bleump)](https://npmjs.com/package/@reliverse/bleump)
[![🐙 GitHub](https://img.shields.io/github/stars/reliverse/bleump?style=social)](https://github.com/reliverse/bleump)

## Features

- 🤖 **Interactive Mode**: Just run and follow the prompts
- 🎯 **Smart Detection**: Finds version patterns in your files
- 🔄 **Multiple Files**: Update versions in many files at once
- 🎮 **Custom Versions**: Want a specific version? No problem!
- 🔍 **Dry Run**: Preview changes before applying them
- ⚡ **Fast & Lightweight**: Built with performance in mind
- 📝 **Custom Source**: Use a different file as version source
- ✏️ **Custom Version**: Useful if you want to downgrade the version

## Installation

```bash
# bun — pnpm — yarn — npm
bun add -D @reliverse/bleump
```

## Quick Start

### Interactive Mode

Just run:

```bash
bun bleump
```

That's it! Follow the prompts to:

1. Choose which files to update
2. Select how you want to bump the version
3. See what changes will be made

### CLI Mode

```bash
# Patch bump (0.0.x)
bun bleump autoPatch package.json src/version.ts

# Minor bump (0.x.0)
bun bleump autoMinor --dryRun  # Preview changes

# Major bump (x.0.0)
bun bleump autoMajor package.json

# Custom version
bun bleump customVersion --customVersion 2.0.0 package.json

# Use different version source
bun bleump autoPatch --mainFile .config/version.ts
```

### Programmatic Usage

#### Basic Example

```ts
import { bumpHandler } from "@reliverse/bleump";

// Patch bump
await bumpHandler(
  "autoPatch",      // mode
  false,            // disable?
  ["package.json"], // files to bump
);

// Custom version
await bumpHandler(
  "customVersion",  // mode
  false,            // disable?
  ["package.json"], // files to bump
  { dryRun: true }, // options
  "1.2.3",         // custom version
);
```

#### Advanced Example

```ts
await bumpHandler(
  "autoPatch",
  false,
  [
    "package.json",
    "src/version.ts",
    ".config/rse.ts"
  ],
  {
    dryRun: true,              // preview only
    mainFile: "package.json",  // version source
  }
);
```

## Configuration

### CLI Options

```bash
Options:
  --bumpMode <mode>       Mode: autoPatch|autoMinor|autoMajor|customVersion
  --customVersion <ver>   Set specific version (with customVersion mode)
  --mainFile <file>       Version source file (default: package.json)
  --dryRun                Preview changes without applying
  --disableBump           Disable bumping (useful for CI)
  --dev                   Run in dev mode
```

### Using with `.config/dler.ts`

Create a `.config/dler.ts` to configure default behavior:

```ts
import { defineConfig } from "@reliverse/dler";

export default defineConfig({
  bumpFilter: [
    "package.json",
    "src/version.ts",
  ],
  bumpMode: "autoPatch",
  bumpDisable: false,
});
```

## Advanced Usage

```ts
import { relinka } from "@reliverse/relinka";
import {
  runMain,
  defineCommand,
  defineArgs,
  selectPrompt,
  inputPrompt,
} from "@reliverse/rempts";
import fs from "fs-extra";
import path from "pathe";
import semver from "semver";

import type { BumpMode } from "./types.js";

import {
  bumpHandler,
  autoIncrementVersion,
  analyzeFiles,
  getCurrentVersion,
} from "./impl.js";
import { showEndPrompt, showStartPrompt } from "./info.js";

const bumpModes: BumpMode[] = [
  "autoPatch",
  "autoMinor",
  "autoMajor",
  "customVersion",
];

const main = defineCommand({
  meta: {
    name: "bleump",
    description:
      "Allows you to bump the version of your project interactively.",
  },
  args: defineArgs({
    dev: {
      type: "boolean",
      description: "Runs the CLI in dev mode",
    },
    bumpMode: {
      type: "string",
      description: "The bump mode to use",
      allowed: bumpModes,
    },
    customVersion: {
      type: "string",
      description: "Custom version to set (only used with customVersion mode)",
    },
    disableBump: {
      type: "boolean",
      description: "Disables the bump (this is useful for CI)",
    },
    filesToBump: {
      type: "positional",
      description:
        "The files to bump (space-separated, e.g. package.json .config/rse.ts)",
    },
    dryRun: {
      type: "boolean",
      description: "Preview changes without writing files",
    },
    mainFile: {
      type: "string",
      description:
        "The file to use as version source (defaults to package.json)",
      default: "package.json",
    },
  }),
  async run({ args }) {
    // Helper to get default filesToBump
    async function getDefaultFilesToBump(): Promise<string[]> {
      const dlerPath = path.resolve(".config/dler.ts");
      if (await fs.pathExists(dlerPath)) {
        try {
          // Dynamically import the config and extract bumpFilter
          const dlerConfig = await import(dlerPath);
          // Support both ESM and CJS default exports
          const config = dlerConfig.default || dlerConfig;
          if (config?.bumpFilter && Array.isArray(config.bumpFilter)) {
            return config.bumpFilter;
          }
          // If using defineConfig wrapper
          if (config?._?.bumpFilter && Array.isArray(config._.bumpFilter)) {
            return config._.bumpFilter;
          }
        } catch (e) {
          relinka(
            "warn",
            `Could not load bumpFilter from .config/dler.ts: ${e}`,
          );
        }
      }
      return ["package.json", ".config/rse.ts"];
    }

    const isCI = process.env.CI === "true";
    const isNonInteractive = !process.stdout.isTTY;
    const dryRun = !!args.dryRun;
    const mainFile = path.resolve(args.mainFile);
    let customVersion = args.customVersion;

    // Validate customVersion if provided
    if (customVersion && !semver.valid(customVersion)) {
      relinka("error", `Invalid custom version: ${customVersion}`);
      process.exit(1);
    }

    let effectiveFilesToBump: string[] = Array.isArray(args.filesToBump)
      ? args.filesToBump
      : args.filesToBump
        ? [args.filesToBump]
        : [];
    if (effectiveFilesToBump.length === 0) {
      effectiveFilesToBump = await getDefaultFilesToBump();
    }
    // Sanitize file list
    const filesToBumpArr = effectiveFilesToBump
      .map((f) => f.trim())
      .filter(Boolean);

    let effectiveBumpMode = args.bumpMode as BumpMode;
    if (!effectiveBumpMode) {
      if (isCI || isNonInteractive) {
        effectiveBumpMode = "autoPatch";
      }
    }

    // =======================
    // NON-INTERACTIVE SESSION
    // =======================

    if (isCI || isNonInteractive) {
      // Validate after defaulting
      if (!bumpModes.includes(effectiveBumpMode)) {
        relinka("error", `Invalid bump mode: ${effectiveBumpMode}`);
        process.exit(1);
      }
      // Validate customVersion is provided when needed
      if (effectiveBumpMode === "customVersion" && !customVersion) {
        relinka(
          "error",
          "customVersion is required when using customVersion mode",
        );
        process.exit(1);
      }
      await bumpHandler(
        effectiveBumpMode,
        args.disableBump,
        filesToBumpArr,
        { dryRun, mainFile },
        customVersion,
      );
      process.exit(0);
    }

    // ===================
    // INTERACTIVE SESSION
    // ===================

    // Read current versions
    let bleumpVersion = "unknown";
    let projectVersion = "unknown";
    try {
      // Read bleump's own version
      const bleumpPkg = await import("../package.json", {
        assert: { type: "json" },
      });
      bleumpVersion = bleumpPkg.default.version || "unknown";

      // Read project's version using getCurrentVersion with resolved path
      projectVersion = await getCurrentVersion(mainFile);
    } catch (e) {
      relinka("warn", `Could not read package versions: ${e}`);
    }

    await showStartPrompt(args.dev, bleumpVersion);

    // Ask for files first
    if (!args.filesToBump || filesToBumpArr.length === 0) {
      const defaultFiles = await getDefaultFilesToBump();
      const input = await inputPrompt({
        title: "Which files do you want to bump?",
        content: `Press <Enter> to use default: ${defaultFiles.join(" ")}`,
        defaultValue: defaultFiles.join(" "),
      });
      effectiveFilesToBump = input
        .split(" ")
        .map((f) => f.trim())
        .filter(Boolean);
    }
    // Sanitize file list again
    const filesToBumpArrInteractive = effectiveFilesToBump
      .map((f) => f.trim())
      .filter(Boolean);

    // Analyze files before proceeding
    const fileAnalysis = await analyzeFiles(
      filesToBumpArrInteractive,
      projectVersion,
    );
    const supportedFiles = fileAnalysis.filter((r) => r.supported);
    const unsupportedFiles = fileAnalysis.filter((r) => !r.supported);
    const mismatchedFiles = fileAnalysis.filter((r) => r.versionMismatch);

    if (supportedFiles.length === 0) {
      relinka("error", "No files can be bumped. Analysis results:");
      for (const file of unsupportedFiles) {
        relinka("error", `  ${file.file}: ${file.reason}`);
      }
      process.exit(1);
    }

    if (mismatchedFiles.length > 0) {
      relinka("warn", "Warning: Some files have mismatched versions:");
      for (const file of mismatchedFiles) {
        relinka(
          "warn",
          `  ${file.file}: found version ${file.detectedVersion} (expected ${projectVersion})`,
        );
      }
    }

    // Then ask for bump mode
    if (!args.bumpMode) {
      // Calculate the actual version numbers for each bump mode
      const patchVersion = autoIncrementVersion(projectVersion, "autoPatch");
      const minorVersion = autoIncrementVersion(projectVersion, "autoMinor");
      const majorVersion = autoIncrementVersion(projectVersion, "autoMajor");

      effectiveBumpMode = await selectPrompt({
        title: `Select a bump mode (current: ${projectVersion} from ${path.relative(process.cwd(), mainFile)})`,
        options: [
          {
            value: "autoPatch",
            label: `autoPatch (${projectVersion} → ${patchVersion})`,
          },
          {
            value: "autoMinor",
            label: `autoMinor (${projectVersion} → ${minorVersion})`,
          },
          {
            value: "autoMajor",
            label: `autoMajor (${projectVersion} → ${majorVersion})`,
          },
          {
            value: "customVersion",
            label: "customVersion (enter your own version)",
          },
        ],
      });

      // If customVersion selected, prompt for the version
      if (effectiveBumpMode === "customVersion") {
        customVersion = await inputPrompt({
          title: "Enter the version number",
          content: "Must be a valid semver (e.g., 1.2.3)",
          defaultValue: projectVersion,
          validate: (input) => {
            if (!semver.valid(input)) {
              return "Please enter a valid semver version (e.g., 1.2.3)";
            }
            return true;
          },
        });
      }
    }
    // Validate after prompt
    if (!bumpModes.includes(effectiveBumpMode)) {
      relinka("error", `Invalid bump mode: ${effectiveBumpMode}`);
      process.exit(1);
    }
    // Validate customVersion is provided when needed
    if (effectiveBumpMode === "customVersion" && !customVersion) {
      relinka(
        "error",
        "customVersion is required when using customVersion mode",
      );
      process.exit(1);
    }

    await bumpHandler(
      effectiveBumpMode,
      args.disableBump,
      filesToBumpArrInteractive,
      { dryRun, mainFile },
      customVersion,
    );

    relinka("log", " ");
    await showEndPrompt();
  },
});

await runMain(main);
```

## Coming Soon

- [ ] 🤖 Auto-commit and push
- [ ] 📝 Smart commit messages
- [ ] 📋 Changelog generation
- [ ] 🔄 More version patterns
- [ ] 🏷️ Auto-tagging

## Contributing

Got ideas? Found a bug? We'd love your help! Check out our [issues](https://github.com/reliverse/bleump/issues) or submit a PR.

## License

MIT © [Nazar Kornienko (blefnk)](https://github.com/blefnk), [Reliverse](https://github.com/reliverse)
