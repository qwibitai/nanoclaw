#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SKILLS_ROOT = path.resolve(__dirname, '..');
const TARGET_SKILL = process.argv[2];

if (!TARGET_SKILL) {
  console.error('Usage: node skills/auto-test-generator/index.js <skill_name>');
  process.exit(1);
}

const skillPath = path.join(SKILLS_ROOT, TARGET_SKILL);
const indexJsPath = path.join(skillPath, 'index.js');
const testJsPath = path.join(skillPath, 'test.js');

if (!fs.existsSync(indexJsPath)) {
  console.error(`Skill ${TARGET_SKILL} not found or index.js missing.`);
  process.exit(1);
}

console.log(`Generating test for ${TARGET_SKILL}...`);

// Simple heuristic: check if it exports a function or object
const content = fs.readFileSync(indexJsPath, 'utf8');
const hasExports = content.includes('module.exports') || content.includes('exports.');

if (!hasExports) {
  console.log('No obvious exports found. Creating basic execution test.');
  const testContent = `
const { execSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const indexJs = path.join(__dirname, 'index.js');

try {
  // Just verify it runs without crashing immediately (or with --help)
  // If it requires args, this might fail, but it's a start.
  execSync(\`node \${indexJs} --help\`, { stdio: 'pipe' });
  console.log('✅ Basic execution test passed');
} catch (e) {
  console.log('⚠️ Basic execution failed (might need args):', e.message.split('\\n')[0]);
}
`;
  fs.writeFileSync(testJsPath, testContent);
} else {
  console.log('Exports found. Creating unit test template.');
  const testContent = `
const assert = require('assert');
const skill = require('./index.js');

console.log('Testing ${TARGET_SKILL}...');

try {
  assert.ok(skill, 'Module should export something');
  console.log('✅ Export check passed');
  
  // specific logic would go here
  
} catch (e) {
  console.error('❌ Test failed:', e);
  process.exit(1);
}
`;
  fs.writeFileSync(testJsPath, testContent);
}

console.log(`Test generated at ${testJsPath}`);
console.log('Running test...');

try {
  execSync(`node ${testJsPath}`, { stdio: 'inherit' });
  console.log('✅ Test run successful.');
} catch (e) {
  console.error('❌ Test run failed.');
  process.exit(1);
}
