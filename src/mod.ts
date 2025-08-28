import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { relinka } from "@reliverse/relinka";
import semver from "semver";

/**
 * Supported bump modes for versioning:
 * - patch: 1.2.3 → 1.2.4 (backwards-compatible bug fixes)
 * - minor: 1.2.3 → 1.3.0 (new backwards-compatible features)
 * - major: 1.2.3 → 2.0.0 (breaking changes)
 * - auto: Automatically determine bump type
 * - manual: Set a specific version (requires bumpSet to be set)
 */
export type BumpMode = "patch" | "minor" | "major" | "auto" | "manual";

export type FileType = "package.json" | "typescript" | "unknown";

export type BumpOptions = {
  dryRun?: boolean;
  verbose?: boolean;
  customVersion?: string;
};

export type FileAnalysis = {
  file: string;
  supported: boolean;
  detectedVersion: string | null;
  versionMismatch: boolean;
  reason: string;
  fileType: FileType;
};

export type VersionInfo = {
  version: string;
  name?: string;
  author?: string;
};

type PackageJson = {
  version?: string;
  name?: string;
  author?: string;
  [key: string]: unknown;
};

// project root directory
const PROJECT_ROOT = process.cwd();

// patterns to find version in different file types
const versionPatterns = {
  packageJson: /"version"\s*:\s*"([^"]+)"/,
  typescript: /version\s*[=:]\s*["']([^"']+)["']|version\s*:\s*["']([^"']+)["']\s*,/,
} as const;

// simple glob to regex converter (basic implementation)
const globToRegex = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex chars
    .replace(/\*\*/g, "DOUBLESTAR") // temp placeholder
    .replace(/\*/g, "[^/]*") // single star
    .replace(/DOUBLESTAR/g, ".*") // double star
    .replace(/\?/g, "[^/]"); // question mark
  return new RegExp(`^${escaped}$`);
};

// check if file matches any of the glob patterns
const matchesGlobs = (filePath: string, globs: string[]): boolean => {
  if (globs.length === 0) return true;
  return globs.some((glob) => globToRegex(glob).test(filePath));
};

// validate semver format using semver package
export const isValidSemver = (version: string): boolean => {
  return semver.valid(version) !== null;
};

// parse semver into components using semver package
export const parseSemver = (version: string): [number, number, number] => {
  const parsed = semver.parse(version);
  if (!parsed) throw new Error(`invalid semver: ${version}`);
  return [parsed.major, parsed.minor, parsed.patch];
};

// bump version based on type using semver package
export const calculateNewVersion = (
  current: string,
  bumpType: BumpMode,
  customVersion?: string,
  bumpSet?: string,
): string => {
  if (bumpType === "manual") {
    // First check if we have a bumpSet value
    if (bumpSet) {
      if (!isValidSemver(bumpSet)) {
        throw new Error(`invalid bumpSet version: ${bumpSet}`);
      }
      return bumpSet;
    }
    // Fall back to customVersion if no bumpSet
    if (!customVersion) {
      throw new Error(
        "either bumpSet (in reliverse.ts) or --customVersion required when bumpType is 'manual'",
      );
    }
    if (!isValidSemver(customVersion)) {
      throw new Error(`invalid custom version: ${customVersion}`);
    }
    return customVersion;
  }

  let releaseType: semver.ReleaseType;
  switch (bumpType) {
    case "major":
      releaseType = "major";
      break;
    case "minor":
      releaseType = "minor";
      break;
    case "patch":
    case "auto": // auto defaults to patch
      releaseType = "patch";
      break;
    default:
      throw new Error(`unknown bump type: ${bumpType}`);
  }

  const newVersion = semver.inc(current, releaseType);
  if (!newVersion) {
    throw new Error(`failed to bump version ${current} with type ${bumpType}`);
  }

  return newVersion;
};

// detect file type based on extension and content
const detectFileType = (filePath: string, content: string): FileType => {
  if (filePath.endsWith("package.json")) return "package.json";
  if (
    (filePath.endsWith(".ts") || filePath.endsWith(".js")) &&
    versionPatterns.typescript.test(content)
  )
    return "typescript";
  return "unknown";
};

// extract version from file content
const extractVersion = (content: string, fileType: FileType): string | null => {
  switch (fileType) {
    case "package.json": {
      const pkgMatch = versionPatterns.packageJson.exec(content);
      return pkgMatch?.[1] ?? null;
    }
    case "typescript": {
      const tsMatch = versionPatterns.typescript.exec(content);
      return tsMatch?.[1] ?? tsMatch?.[2] ?? null;
    }
    default:
      return null;
  }
};

// read and parse file to get version info
export const readFileInfo = async (filePath: string): Promise<VersionInfo | null> => {
  try {
    const content = await readFile(filePath, "utf-8");

    if (filePath.endsWith("package.json")) {
      const pkg = JSON.parse(content) as PackageJson;
      return {
        version: pkg.version ?? "",
        name: pkg.name ?? "",
        author: pkg.author ?? "",
      };
    }

    const fileType = detectFileType(filePath, content);
    const version = extractVersion(content, fileType);

    return version ? { version } : null;
  } catch {
    return null;
  }
};

// get current version from specified file and field
export const getCurrentVersion = async (
  filePath = "package.json",
  field = "version",
): Promise<string> => {
  try {
    const content = await readFile(filePath, "utf-8");

    if (filePath.endsWith("package.json")) {
      const pkg = JSON.parse(content) as PackageJson;
      const value = pkg[field];
      if (!value || typeof value !== "string") {
        throw new Error(`field '${field}' not found in ${filePath}`);
      }
      return value;
    }

    // for non-package.json files, use pattern matching
    const pattern = new RegExp(`${field}\\s*[=:]\\s*["']([^"']+)["']`);
    const match = content.match(pattern);
    if (!match?.[1]) {
      throw new Error(`field '${field}' not found in ${filePath}`);
    }
    return match[1];
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(`failed to read ${filePath}: ${error}`);
  }
};

// get package name
export const getPackageName = async (
  filePath = "package.json",
  field = "name",
): Promise<string> => {
  return getCurrentVersion(filePath, field);
};

// get package author
export const getPackageAuthor = async (
  filePath = "package.json",
  field = "author",
): Promise<string> => {
  return getCurrentVersion(filePath, field);
};

// update version in file content
const updateVersionInContent = (
  content: string,
  newVersion: string,
  fileType: FileType,
): string => {
  switch (fileType) {
    case "package.json":
      return content.replace(versionPatterns.packageJson, `"version": "${newVersion}"`);
    case "typescript": {
      return content.replace(versionPatterns.typescript, (match) => {
        const delimiter = match.includes('"') ? '"' : "'";
        const operator = match.includes("=") ? "=" : ":";
        const hasComma = match.includes(",");
        return `version${operator} ${delimiter}${newVersion}${delimiter}${hasComma ? "," : ""}`;
      });
    }
    default:
      throw new Error("unsupported file type for version update");
  }
};

// analyze a list of files
export const analyzeFiles = async (
  files: string[],
  referenceVersion: string,
): Promise<FileAnalysis[]> => {
  const results: FileAnalysis[] = [];

  for (const file of files) {
    try {
      const content = await readFile(file, "utf-8");
      const fileType = detectFileType(file, content);
      const detectedVersion = extractVersion(content, fileType);

      let supported = fileType !== "unknown";
      let versionMismatch = false;
      let reason = "";

      if (!supported) {
        reason = "unsupported file type";
      } else if (!detectedVersion) {
        reason = "no version field found";
        supported = false;
      } else if (!semver.eq(detectedVersion, referenceVersion)) {
        versionMismatch = true;
        reason = `version mismatch: found ${detectedVersion}, expected ${referenceVersion}`;
      } else {
        reason = "ok";
      }

      results.push({
        file,
        supported,
        detectedVersion,
        versionMismatch,
        reason,
        fileType,
      });
    } catch (error) {
      results.push({
        file,
        supported: false,
        detectedVersion: null,
        versionMismatch: false,
        reason: `read error: ${error}`,
        fileType: "unknown",
      });
    }
  }

  return results;
};

export type DlerConfig = {
  bumpDisable?: boolean;
  bumpFilter?: string[];
  bumpMode?: BumpMode;
  bumpSet?: string;
};

// try to load config file with file list and bump settings
export const getConfigFromDler = async (): Promise<{
  files: string[];
  bumpDisable?: boolean;
  bumpMode?: BumpMode;
  bumpSet?: string;
}> => {
  try {
    await access("reliverse.ts");
    const content = await readFile("reliverse.ts", "utf-8");

    // Extract files from bumpFilter array in dler config
    const filesMatch = /bumpFilter\s*[:=]\s*\[([\s\S]*?)\]/.exec(content);
    const bumpDisableMatch = /bumpDisable\s*[:=]\s*(true|false)/.exec(content);
    const bumpModeMatch = /bumpMode\s*[:=]\s*["']([^"']+)["']/.exec(content);
    const bumpSetMatch = /bumpSet\s*[:=]\s*["']([^"']+)["']/.exec(content);

    const files = filesMatch?.[1]
      ? filesMatch[1]
          .split(",")
          .map((f) => f.trim().replace(/["']/g, ""))
          .filter(Boolean)
      : ["package.json", "reliverse.ts"];

    const bumpDisable = bumpDisableMatch ? bumpDisableMatch[1] === "true" : undefined;
    const bumpMode = bumpModeMatch?.[1] as BumpMode | undefined;
    const bumpSet = bumpSetMatch?.[1];

    return {
      files,
      bumpDisable,
      bumpMode,
      bumpSet,
    };
  } catch {
    // config file doesn't exist or can't be read
    return {
      files: ["package.json", "reliverse.ts"],
    };
  }
};

// try to load config file with file list
export const getFilesFromConfigOrDefault = async (): Promise<string[]> => {
  const config = await getConfigFromDler();
  return config.files;
};

// main bump function
export const bumpVersion = async (
  bumpType: BumpMode,
  files: string[] = [],
  options: BumpOptions = {},
  globs: string[] = [],
  bumpSet?: string,
): Promise<void> => {
  const { dryRun = false, verbose = false, customVersion } = options;

  // get current version from package.json
  const currentVersion = await getCurrentVersion();
  const newVersion = calculateNewVersion(currentVersion, bumpType, customVersion, bumpSet);

  if (verbose) {
    relinka("verbose", `bumping version: ${currentVersion} → ${newVersion}`);
  }

  // filter files by globs if provided
  const filteredFiles = files.filter((file) => matchesGlobs(file, globs));

  const updateResults: {
    file: string;
    success: boolean;
    error?: string;
  }[] = [];

  for (const file of filteredFiles) {
    try {
      const content = await readFile(file, "utf-8");
      const fileType = detectFileType(file, content);

      if (fileType === "unknown") {
        if (verbose) relinka("log", `skipping unsupported file: ${file}`);
        continue;
      }

      const currentFileVersion = extractVersion(content, fileType);
      if (!currentFileVersion) {
        if (verbose) relinka("log", `no version found in: ${file}`);
        continue;
      }

      const updatedContent = updateVersionInContent(content, newVersion, fileType);

      if (dryRun) {
        relinka("log", `- [dry-run] would update ${file}`);
        updateResults.push({ file, success: true });
      } else {
        await writeFile(file, updatedContent, "utf-8");
        if (verbose) {
          relinka("verbose", `- updated ${file}`);
        }
        updateResults.push({ file, success: true });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      updateResults.push({ file, success: false, error: errorMsg });

      if (verbose) {
        relinka("error", `failed to update ${file}: ${errorMsg}`);
      }
    }
  }

  // check for failures and throw if any updates failed
  const failures = updateResults.filter((r) => !r.success);
  if (failures.length > 0) {
    const failedFiles = failures.map((f) => `${f.file}: ${f.error}`).join(", ");
    throw new Error(`failed to update version in files: ${failedFiles}`);
  }

  if (verbose && !dryRun) {
    relinka(
      "verbose",
      `successfully bumped ${updateResults.length} files to version ${newVersion}`,
    );
  }
};

// convenience function to bump with analysis
export const bumpVersionWithAnalysis = async (
  bumpType: BumpMode,
  files: string[] = [],
  options: BumpOptions = {},
  bumpSet?: string,
): Promise<void> => {
  const currentVersion = await getCurrentVersion();
  const analysis = await analyzeFiles(files, currentVersion);

  // only bump supported files
  const supportedFiles = analysis.filter((a) => a.supported).map((a) => a.file);

  await bumpVersion(bumpType, supportedFiles, options, [], bumpSet);
};

// additional utility functions using semver
export const compareVersions = (version1: string, version2: string): number => {
  return semver.compare(version1, version2);
};

export const getLatestVersion = (versions: string[]): string | null => {
  const validVersions = versions.filter(isValidSemver);
  if (validVersions.length === 0) return null;
  return semver.maxSatisfying(validVersions, "*");
};

export const isPrerelease = (version: string): boolean => {
  return semver.prerelease(version) !== null;
};

export const satisfiesRange = (version: string, range: string): boolean => {
  return semver.satisfies(version, range);
};

export type BumpConfig = {
  bumpType: BumpMode;
  customVersion?: string;
  dryRun?: boolean;
  verbose?: boolean;
};

export type SessionConfig = {
  isCI: boolean;
  isNonInteractive: boolean;
  mainFile: string;
  filesToBump: string[];
  options: {
    dryRun: boolean;
    verbose: boolean;
    customVersion?: string;
  };
  bumpType: BumpMode;
};

// Validate bump configuration
export function validateBumpConfig(bumpType: BumpMode, customVersion?: string): void {
  if (!["patch", "minor", "major", "auto", "manual"].includes(bumpType)) {
    throw new Error(`Invalid bump type: ${bumpType}`);
  }
  if (bumpType === "manual" && !customVersion) {
    throw new Error("customVersion is required when using manual bump type");
  }
  if (customVersion && !isValidSemver(customVersion)) {
    throw new Error(`Invalid custom version: ${customVersion}`);
  }
}

// Get default bump type based on environment
export function getDefaultBumpMode(isCI: boolean, isNonInteractive: boolean): BumpMode {
  if (isCI || isNonInteractive) {
    return "patch";
  }
  return "auto";
}

// Handle non-interactive session
export async function handleNonInteractiveSession(config: SessionConfig): Promise<void> {
  const { bumpType, options, filesToBump } = config;
  validateBumpConfig(bumpType, options.customVersion);

  try {
    await bumpVersionWithAnalysis(bumpType, filesToBump, options);
  } catch (error) {
    throw new Error(`Failed to bump version: ${error}`);
  }
}

// Handle interactive session
export async function handleInteractiveSession(
  config: SessionConfig,
  projectVersion: string,
): Promise<{
  supportedFiles: FileAnalysis[];
  mismatchedFiles: FileAnalysis[];
  fileAnalysis: FileAnalysis[];
}> {
  const { filesToBump } = config;

  // Analyze files before proceeding
  const fileAnalysis = await analyzeFiles(filesToBump, projectVersion);
  const supportedFiles = fileAnalysis.filter((r) => r.supported);
  const unsupportedFiles = fileAnalysis.filter((r) => !r.supported);
  const mismatchedFiles = fileAnalysis.filter((r) => r.versionMismatch);

  if (supportedFiles.length === 0) {
    const reasons = unsupportedFiles.map((f) => `${f.file}: ${f.reason}`).join("\n");
    throw new Error(`No files can be bumped. Analysis results:\n${reasons}`);
  }

  if (mismatchedFiles.length > 0) {
    const mismatches = mismatchedFiles
      .map((f) => `${f.file}: found version ${f.detectedVersion} (expected ${projectVersion})`)
      .join("\n");
    relinka("warn", "Some files have mismatched versions:");
    relinka("info", mismatches);
    throw new Error("Please fix the version mismatches before continuing");
  }

  return {
    supportedFiles,
    mismatchedFiles,
    fileAnalysis,
  };
}

/**
 * Checks if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Updates a specific config value in the dler.ts config file
 */
async function updateDlerConfig(key: string, value: string | boolean | string[]): Promise<void> {
  const dlerCfgPath = join(PROJECT_ROOT, "reliverse.ts");

  if (!(await fileExists(dlerCfgPath))) {
    relinka(
      "verbose",
      `No reliverse.ts found to update ${key}. This is not an error, but the ${key} flag will not be updated.`,
    );
    return;
  }

  try {
    const content = await readFile(dlerCfgPath, "utf-8");

    // Format the value based on its type
    const formattedValue = Array.isArray(value)
      ? `[${value.map((v) => `"${v}"`).join(", ")}]`
      : typeof value === "string"
        ? `"${value}"`
        : value;

    // Create the replacement pattern
    const pattern = new RegExp(`${key}\\s*[:=]\\s*([^,}\\]]+)`);
    const updatedContent = content.replace(pattern, `${key}: ${formattedValue}`);

    await writeFile(dlerCfgPath, updatedContent, "utf-8");
    relinka("verbose", `Successfully updated ${key} to ${formattedValue} in reliverse.ts`);
  } catch (error) {
    relinka(
      "verbose",
      `Failed to update ${key} in ${dlerCfgPath}. This is not an error, but the ${key} flag will not be updated.`,
      error,
    );
  }
}

/**
 * Sets the bumpDisable flag to a specific value in the configuration.
 * @param value The boolean value to set bumpDisable to
 */
export async function setBumpDisabledValueTo(value: boolean): Promise<void> {
  // Set the value
  await updateDlerConfig("bumpDisable", value);
}

/**
 * Handles version bumping using @reliverse/bleump
 */
export async function bumpHandler(
  bumpMode: BumpMode,
  bumpDisable: boolean,
  bumpFilter: string[],
  bumpSet?: string,
): Promise<void> {
  if (bumpDisable) {
    relinka("verbose", "Version bumping is paused");
    return;
  }

  try {
    const files = bumpFilter.length > 0 ? bumpFilter : ["package.json"];

    await bumpVersionWithAnalysis(bumpMode, files, {
      dryRun: false,
      verbose: true,
      customVersion: bumpMode === "manual" ? bumpSet : undefined,
    });

    relinka("verbose", "Version bump completed successfully");
  } catch (error) {
    relinka("error", "Failed to bump version", error);
    throw error;
  }
}

/**
 * Checks if version bumping is currently disabled.
 * @returns true if bumping is disabled, false otherwise
 */
export async function isBumpDisabled(): Promise<boolean> {
  const config = await getConfigFromDler();
  const bumpDisable = config.bumpDisable ?? false;

  // Bumping is disabled if the flag is true
  return bumpDisable;
}
