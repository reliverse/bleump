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

import type { BumpMode } from "./types.js";

import { bumpHandler } from "./impl.js";
import { showEndPrompt, showStartPrompt } from "./info.js";

const bumpModes: BumpMode[] = ["autoPatch", "autoMinor", "autoMajor"];

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
      await bumpHandler(effectiveBumpMode, args.disableBump, filesToBumpArr, {
        dryRun,
      });
      process.exit(0);
    }

    // ===================
    // INTERACTIVE SESSION
    // ===================

    // Read current version for prompt
    let currentVersion = "unknown";
    try {
      const pkg = await import("../package.json", { assert: { type: "json" } });
      currentVersion = pkg.default.version || "unknown";
    } catch {
      /* empty */
    }

    await showStartPrompt(args.dev, currentVersion);

    if (!args.bumpMode) {
      effectiveBumpMode = await selectPrompt({
        title: `Select a bump mode (current version: ${currentVersion})`,
        options: [
          { value: "autoPatch", label: "autoPatch" },
          { value: "autoMinor", label: "autoMinor" },
          { value: "autoMajor", label: "autoMajor" },
        ],
      });
    }
    // Validate after prompt
    if (!bumpModes.includes(effectiveBumpMode)) {
      relinka("error", `Invalid bump mode: ${effectiveBumpMode}`);
      process.exit(1);
    }

    if (!args.filesToBump || filesToBumpArr.length === 0) {
      const defaultFiles = await getDefaultFilesToBump();
      const input = await inputPrompt({
        title:
          "Which files do you want to bump? (separate multiple files with space)",
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

    await bumpHandler(
      effectiveBumpMode,
      args.disableBump,
      filesToBumpArrInteractive,
      { dryRun },
    );

    relinka("log", " ");
    await showEndPrompt();
  },
});

await runMain(main);
