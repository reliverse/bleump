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
