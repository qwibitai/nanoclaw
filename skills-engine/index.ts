export { applySkill } from './apply.js';
export { clearBackup, createBackup, restoreBackup } from './backup.js';
export {
  BACKUP_DIR,
  BASE_DIR,
  SKILLS_SCHEMA_VERSION,
  CUSTOM_DIR,
  LOCK_FILE,
  NANOCLAW_DIR,
  RESOLUTIONS_DIR,
  SHIPPED_RESOLUTIONS_DIR,
  STATE_FILE,
} from './constants.js';
export {
  abortCustomize,
  commitCustomize,
  isCustomizeActive,
  startCustomize,
} from './customize.js';
export { executeFileOps } from './file-ops.js';
export { initNanoclawDir } from './init.js';
export { acquireLock, isLocked, releaseLock } from './lock.js';
export {
  checkConflicts,
  checkCoreVersion,
  checkDependencies,
  checkSystemVersion,
  readManifest,
} from './manifest.js';
export {
  cleanupMergeState,
  isGitRepo,
  mergeFile,
  runRerere,
  setupRerereAdapter,
} from './merge.js';
export {
  loadPathRemap,
  recordPathRemap,
  resolvePathRemap,
} from './path-remap.js';
export { rebase } from './rebase.js';
export { findSkillDir, replaySkills } from './replay.js';
export type { ReplayOptions, ReplayResult } from './replay.js';
export { uninstallSkill } from './uninstall.js';
export { initSkillsSystem, migrateExisting } from './migrate.js';
export {
  clearAllResolutions,
  findResolutionDir,
  loadResolutions,
  saveResolution,
} from './resolution-cache.js';
export { applyUpdate, previewUpdate } from './update.js';
export {
  compareSemver,
  computeFileHash,
  getAppliedSkills,
  getCustomModifications,
  readState,
  recordCustomModification,
  recordSkillApplication,
  writeState,
} from './state.js';
export {
  areRangesCompatible,
  mergeDockerComposeServices,
  mergeEnvAdditions,
  mergeNpmDependencies,
  runNpmInstall,
} from './structured.js';
export type {
  AppliedSkill,
  ApplyResult,
  CustomModification,
  FileOpsResult,
  FileOperation,
  MergeResult,
  RebaseResult,
  ResolutionMeta,
  SkillManifest,
  SkillState,
  UninstallResult,
  UpdatePreview,
  UpdateResult,
} from './types.js';
