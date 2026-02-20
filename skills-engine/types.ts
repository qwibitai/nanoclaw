export interface SkillManifest {
  skill: string;
  version: string;
  description: string;
  core_version: string;
  adds: string[];
  modifies: string[];
  structured?: {
    npm_dependencies?: Record<string, string>;
    env_additions?: string[];
    docker_compose_services?: Record<string, unknown>;
  };
  file_ops?: FileOperation[];
  conflicts: string[];
  depends: string[];
  test?: string;
  author?: string;
  license?: string;
  min_skills_system_version?: string;
  tested_with?: string[];
  post_apply?: string[];
}

export interface SkillState {
  skills_system_version: string;
  core_version: string;
  applied_skills: AppliedSkill[];
  custom_modifications?: CustomModification[];
  path_remap?: Record<string, string>;
  rebased_at?: string;
}

export interface AppliedSkill {
  name: string;
  version: string;
  applied_at: string;
  file_hashes: Record<string, string>;
  structured_outcomes?: Record<string, unknown>;
  custom_patch?: string;
  custom_patch_description?: string;
}

export interface ApplyResult {
  success: boolean;
  skill: string;
  version: string;
  mergeConflicts?: string[];
  backupPending?: boolean;
  untrackedChanges?: string[];
  error?: string;
}

export interface MergeResult {
  clean: boolean;
  exitCode: number;
}

export interface FileOperation {
  type: 'rename' | 'delete' | 'move';
  from?: string;
  to?: string;
  path?: string;
}

export interface FileOpsResult {
  success: boolean;
  executed: FileOperation[];
  warnings: string[];
  errors: string[];
}

export interface CustomModification {
  description: string;
  applied_at: string;
  files_modified: string[];
  patch_file: string;
}

export interface FileInputHashes {
  base: string;     // SHA-256 of .nanoclaw/base/<relPath>
  current: string;  // SHA-256 of working tree <relPath> before this merge
  skill: string;    // SHA-256 of skill's modify/<relPath>
}

export interface ResolutionMeta {
  skills: string[];
  apply_order: string[];
  core_version: string;
  resolved_at: string;
  tested: boolean;
  test_passed: boolean;
  resolution_source: 'maintainer' | 'user' | 'claude';
  input_hashes: Record<string, string>;
  output_hash: string;
  file_hashes: Record<string, FileInputHashes>;
}

export interface UpdatePreview {
  currentVersion: string;
  newVersion: string;
  filesChanged: string[];
  filesDeleted: string[];
  conflictRisk: string[];
  customPatchesAtRisk: string[];
}

export interface UpdateResult {
  success: boolean;
  previousVersion: string;
  newVersion: string;
  mergeConflicts?: string[];
  backupPending?: boolean;
  customPatchFailures?: string[];
  skillReapplyResults?: Record<string, boolean>;
  error?: string;
}

export interface UninstallResult {
  success: boolean;
  skill: string;
  customPatchWarning?: string;
  replayResults?: Record<string, boolean>;
  error?: string;
}

export interface RebaseResult {
  success: boolean;
  patchFile?: string;
  filesInPatch: number;
  rebased_at?: string;
  mergeConflicts?: string[];
  backupPending?: boolean;
  error?: string;
}
