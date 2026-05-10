/**
 * Skill Registry — Public API
 *
 * Re-exports the main interfaces for use by the rest of NanoClaw.
 */

// Types
export type {
  SkillMetadata,
  SkillRegistry,
  SkillType,
  InstallMethod,
  MarketplaceSource,
  InstalledSkill,
  InstalledSkillsState,
} from './types.js';

// Schemas
export {
  SkillMetadataSchema,
  SkillRegistrySchema,
  InstalledSkillSchema,
  InstalledSkillsStateSchema,
} from './schema.js';

// Registry client
export {
  fetchRegistry,
  fetchAllRegistries,
  getAllSkills,
  searchSkills,
  findSkill,
  loadMarketplaceSources,
  clearCache,
  OFFICIAL_MARKETPLACE,
} from './registry-client.js';

// Local state
export {
  loadInstalledSkills,
  saveInstalledSkills,
  markSkillInstalled,
  markSkillUninstalled,
  getInstalledSkill,
  getInstalledSkillNames,
  isSkillInstalled,
  detectInstalledFromGit,
} from './local-state.js';

// Installer
export { installSkill, uninstallSkill } from './installer.js';

// CLI
export { handleSkillCommand } from './cli.js';
