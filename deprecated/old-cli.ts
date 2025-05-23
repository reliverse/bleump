import { relinka } from "@reliverse/relinka";
import {
  runMain,
  defineCommand,
  defineArgs,
  selectPrompt,
  inputPrompt,
  startPrompt,
  endPrompt,
} from "@reliverse/rempts";
import fs from "fs-extra";
import path from "pathe";
import semver from "semver";

import {
  bumpHandler,
  autoIncrementVersion,
  analyzeFiles,
  getCurrentVersion,
} from "./old-mod.js";

export type BumpMode =
  | "autoMajor"
  | "autoMinor"
  | "autoPatch"
  | "customVersion";

export type BumpOptions = {
  dryRun?: boolean;
  /** The file to use as the source of truth for version (defaults to package.json) */
  mainFile?: string;
  /** Custom version to set (only used with customVersion mode) */
  customVersion?: string;
};

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

async function showStartPrompt(isDev: boolean, currentVersion: string) {
  await startPrompt({
    titleColor: "inverse",
    clearConsole: false,
    packageName: "bleump",
    packageVersion: currentVersion,
    isDev,
  });
}
async function showEndPrompt() {
  await endPrompt({
    title:
      "❤️  Please support bleump: https://github.com/sponsors/blefnk\n│  📝  Feedback: https://github.com/blefnk/bleump/issues",
    titleColor: "dim",
  });
}
