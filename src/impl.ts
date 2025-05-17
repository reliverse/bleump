import { VERSION_PATTERNS } from "@reliverse/bleregex";
import { relinka } from "@reliverse/relinka";
import fs from "fs-extra";
import pMap from "p-map";
import path from "pathe";
import { readPackageJSON } from "pkg-types";
import semver from "semver";
import { glob } from "tinyglobby";

import type { BumpMode } from "./types.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/.cache/**",
  "**/tmp/**",
  "**/.temp/**",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lock",
];
const SHOW_VERBOSE = false;
const CONCURRENCY_DEFAULT = 5;

/**
 * Handles version bumping.
 */
export async function bumpHandler(
  bumpMode: BumpMode,
  bumpDisable: boolean,
  bumpFilter: string[],
  options?: { dryRun?: boolean },
): Promise<void> {
  const dryRun = !!options?.dryRun;
  if (!["autoPatch", "autoMinor", "autoMajor"].includes(bumpMode)) {
    throw new Error("Invalid bump mode");
  }
  if (bumpDisable) {
    relinka(
      "log",
      "Skipping version bump because it is either `bumpDisable: true` or `commonPubPause: true` in your dler config.",
    );
    return;
  }

  const pkgPath = path.resolve("package.json");
  if (!(await fs.pathExists(pkgPath))) {
    throw new Error("package.json not found");
  }
  const pkgJson = await readPackageJSON();
  if (!pkgJson.version) {
    throw new Error("No version field found in package.json");
  }
  const oldVersion = pkgJson.version;

  if (!semver.valid(oldVersion)) {
    throw new Error(`Invalid existing version in package.json: ${oldVersion}`);
  }
  relinka(
    "null",
    `Auto-incrementing version from ${oldVersion} using "${bumpMode}"${dryRun ? " [dry run]" : ""}`,
  );
  const incremented = autoIncrementVersion(oldVersion, bumpMode);
  if (oldVersion !== incremented) {
    await bumpVersions(oldVersion, incremented, bumpFilter, { dryRun });
  } else {
    relinka("log", `Version is already at ${oldVersion}, no bump needed.`);
  }
}

/**
 * Auto-increments a semantic version based on the specified bumpMode.
 */
function autoIncrementVersion(
  oldVersion: string,
  bumpMode: "autoMajor" | "autoMinor" | "autoPatch",
): string {
  if (!semver.valid(oldVersion)) {
    throw new Error(`Can't auto-increment invalid version: ${oldVersion}`);
  }
  const releaseTypeMap = {
    autoMajor: "major",
    autoMinor: "minor",
    autoPatch: "patch",
  } as const;
  const newVer = semver.inc(oldVersion, releaseTypeMap[bumpMode]);
  if (!newVer) {
    throw new Error(`semver.inc failed for ${oldVersion} and mode ${bumpMode}`);
  }
  return newVer;
}

/**
 * Updates version strings in a file's content.
 */
async function updateVersionInContent(
  filePath: string,
  content: string,
  oldVersion: string,
  newVersion: string,
): Promise<boolean> {
  let updatedContent = content;
  let changed = false;

  // Debug: Log which file is being checked and what patterns are being used
  relinka("verbose", `[updateVersionInContent] Checking file: ${filePath}`);

  if (/\.(json|jsonc|json5)$/.test(filePath)) {
    const jsonPattern = VERSION_PATTERNS.find((p) => p.id === "json-version");
    if (jsonPattern && content.includes(`"version": "${oldVersion}"`)) {
      relinka(
        "verbose",
        `[updateVersionInContent] JSON pattern matched in: ${filePath}`,
      );
      updatedContent = content.replace(
        jsonPattern.pattern(oldVersion),
        `"version": "${newVersion}"`,
      );
      changed = true;
    }
  } else if (filePath.endsWith(".ts")) {
    const tsPatterns = VERSION_PATTERNS.filter((p) => p.id.startsWith("ts-"));
    for (const { id, pattern } of tsPatterns) {
      const regex = pattern(oldVersion);
      if (regex.test(updatedContent)) {
        relinka(
          "verbose",
          `[updateVersionInContent] Pattern '${id}' matched in: ${filePath}`,
        );
        updatedContent = updatedContent.replace(regex, `$1${newVersion}$2`);
        changed = true;
      } else {
        relinka(
          "verbose",
          `[updateVersionInContent] Pattern '${id}' did NOT match in: ${filePath}`,
        );
      }
    }
  }

  if (changed) {
    relinka(
      "verbose",
      `[updateVersionInContent] Version updated in: ${filePath}`,
    );
    await writeFileSafe(filePath, updatedContent, "version update");
  } else {
    relinka(
      "verbose",
      `[updateVersionInContent] No version updated in: ${filePath}`,
    );
  }
  return changed;
}

/**
 * Reads a file safely and returns its content.
 */
async function readFileSafe(filePath: string, reason: string): Promise<string> {
  const distName = "example";
  try {
    const content = await fs.readFile(filePath, "utf8");
    if (SHOW_VERBOSE) {
      relinka(
        "verbose",
        `[${distName}] Successfully read file: ${filePath} [Reason: ${reason}]`,
      );
    }
    return content;
  } catch (error) {
    relinka(
      "error",
      `[${distName}] Failed to read file: ${filePath} [Reason: ${reason}]`,
      error,
    );
    throw error;
  }
}

/**
 * Writes content to a file safely.
 */
async function writeFileSafe(
  filePath: string,
  content: string,
  reason: string,
): Promise<void> {
  try {
    await fs.writeFile(filePath, content, "utf8");
    relinka(
      "verbose",
      `Successfully wrote file: ${filePath} [Reason: ${reason}]`,
    );
  } catch (error) {
    relinka(
      "error",
      `Failed to write file: ${filePath} [Reason: ${reason}]`,
      error,
    );
    throw error;
  }
}

/**
 * Updates version strings in files based on file type and relative paths.
 */
async function bumpVersions(
  oldVersion: string,
  newVersion: string,
  bumpFilter: string[],
  options?: { dryRun?: boolean },
): Promise<void> {
  const dryRun = !!options?.dryRun;
  relinka(
    "verbose",
    `Starting bumpVersions from ${oldVersion} to ${newVersion}${dryRun ? " [dry run]" : ""}`,
  );
  try {
    // Clean and create glob patterns based on the bumpFilter
    const filePatterns: string[] = [];
    if (bumpFilter.length > 0) {
      for (const filter of bumpFilter) {
        const trimmed = filter.trim();
        if (!trimmed) continue;
        // Allow direct glob patterns
        if (trimmed.includes("*") || trimmed.includes("?")) {
          filePatterns.push(trimmed);
          continue;
        }
        if (trimmed.includes("/") || trimmed.includes("\\")) {
          filePatterns.push(`**/${trimmed}`);
          continue;
        }
        if (trimmed.includes(".")) {
          filePatterns.push(`**/${trimmed}`);
          continue;
        }
        filePatterns.push(`**/${trimmed}.*`);
      }
      relinka(
        "verbose",
        `Generated patterns from filters: ${filePatterns.join(", ")}`,
      );
    } else {
      filePatterns.push("**/package.json");
      relinka(
        "verbose",
        "No filters provided, falling back to only process package.json",
      );
    }

    // Always ignore these directories
    const ignorePatterns = [
      "**/node_modules/**",
      "**/.git/**",
      ...IGNORE_PATTERNS,
    ];

    // Try to read .gitignore file and add its patterns to the ignore list
    try {
      const gitignorePath = path.join(PROJECT_ROOT, ".gitignore");
      if (await fs.pathExists(gitignorePath)) {
        const gitignoreContent = await fs.readFile(gitignorePath, "utf8");
        const gitignorePatterns = gitignoreContent
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"))
          .map((pattern) => {
            // Convert .gitignore patterns to glob patterns
            if (pattern.startsWith("/")) {
              // Pattern starting with / in gitignore means root-relative
              // Convert to a relative pattern but ensure it doesn't start with /
              return pattern.substring(1);
            }
            if (pattern.endsWith("/")) {
              // Pattern ending with / matches directories
              return `**/${pattern}**`;
            }
            // Regular pattern
            return `**/${pattern}`;
          });

        if (gitignorePatterns.length > 0) {
          relinka(
            "verbose",
            `Bump will not process ${gitignorePatterns.length} patterns listed in .gitignore`,
          );
          ignorePatterns.push(...gitignorePatterns);
        }
      }
    } catch (err) {
      relinka("verbose", `Could not process .gitignore: ${err}`);
    }

    // Get all matching files using tinyglobby
    const matchedFiles = await glob(filePatterns, {
      absolute: true,
      cwd: PROJECT_ROOT,
      dot: true,
      ignore: ignorePatterns,
    });

    relinka(
      "verbose",
      `Found ${matchedFiles.length} files to check for version bumping`,
    );

    relinka(
      "verbose",
      `[bumpVersions] File patterns: ${filePatterns.join(", ")}`,
    );
    relinka(
      "verbose",
      `[bumpVersions] Ignore patterns: ${ignorePatterns.join(", ")}`,
    );
    relinka(
      "verbose",
      `[bumpVersions] Matched files: ${matchedFiles.join(", ")}`,
    );

    // Process each file to update version
    let modifiedCount = 0;
    const modifiedFiles: string[] = [];
    await pMap(
      matchedFiles,
      async (file) => {
        try {
          if (!(await fs.pathExists(file))) {
            relinka("verbose", `File does not exist (skipped): ${file}`);
            return;
          }
          const content = await readFileSafe(file, "bumpVersions");
          const modified = await updateVersionInContent(
            file,
            content,
            oldVersion,
            newVersion,
          );
          if (modified) {
            modifiedCount++;
            modifiedFiles.push(file);
            relinka("verbose", `Updated version in: ${file}`);
            if (!dryRun) {
              // Already written in updateVersionInContent
            } else {
              relinka("log", `[dry run] Would update version in: ${file}`);
            }
          }
        } catch (err) {
          relinka("error", `Error processing file ${file}: ${err}`);
        }
      },
      { concurrency: CONCURRENCY_DEFAULT },
    );

    if (modifiedCount > 0) {
      if (dryRun) {
        relinka(
          "null",
          `[dry run] Would update version from ${oldVersion} to ${newVersion} in ${modifiedCount} file(s):\n${modifiedFiles.join("\n")}`,
        );
      } else {
        relinka(
          "null",
          `Updated version from ${oldVersion} to ${newVersion} in ${modifiedCount} file(s):\n${modifiedFiles.join("\n")}`,
        );
      }
    } else {
      relinka(
        "warn",
        dryRun
          ? "[dry run] No files would be updated with the new version"
          : "No files were updated with the new version",
      );
    }
  } catch (error) {
    relinka("error", "Failed to bump versions:", error);
    throw error;
  }
  relinka("verbose", "Exiting bumpVersions");
}
