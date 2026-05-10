/**
 * Zod schemas for validating skill registry data.
 */

import { z } from 'zod';

export const SkillTypeSchema = z.enum([
  'feature',
  'utility',
  'operational',
  'container',
]);

export const InstallMethodSchema = z.enum([
  'branch-merge',
  'copy',
  'instruction-only',
]);

export const SkillMetadataSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9-]+$/,
      'Skill names must be lowercase alphanumeric with hyphens',
    ),
  displayName: z.string().min(1),
  description: z.string().min(1).max(200),
  longDescription: z.string().optional(),
  type: SkillTypeSchema,
  installMethod: InstallMethodSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Must be semver (x.y.z)'),
  author: z.string().min(1),
  license: z.string().optional(),
  tags: z.array(z.string()),
  branch: z.string().optional(),
  remote: z.string().url().optional(),
  dependencies: z.array(z.string()),
  triggers: z.array(z.string()),
  docsUrl: z.string().url().optional(),
  updatedAt: z.string().datetime(),
  minVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .optional(),
});

export const SkillRegistrySchema = z.object({
  schemaVersion: z.string(),
  generatedAt: z.string().datetime(),
  skills: z.array(SkillMetadataSchema),
});

export const InstalledSkillSchema = z.object({
  name: z.string(),
  version: z.string(),
  installedAt: z.string().datetime(),
  source: z.string(),
  mergeCommit: z.string().optional(),
  updateAvailable: z.boolean().optional(),
});

export const InstalledSkillsStateSchema = z.object({
  version: z.string(),
  skills: z.record(z.string(), InstalledSkillSchema),
});
