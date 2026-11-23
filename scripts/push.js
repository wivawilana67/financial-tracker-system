#!/usr/bin/env node
'use strict';

/**
 * Deploy helper for the TEST and PROD Apps Script projects.
 *
 *   node scripts/push.js <test|prod> [--allow-branch]
 *   (npm run push-test / npm run push-prod)
 *
 * 1. PROD only: refuses unless the branch is master and the tree is clean
 *    (override with --allow-branch).
 * 2. Copies the gitignored .clasp-<env>.json over .clasp.json, because clasp
 *    always reads .clasp.json.
 * 3. `clasp push -f` uploads the root Apps Script files.
 * 4. If .deploy.json holds a web app deployment ID for this env, `clasp deploy -i <id>`
 *    moves that deployment to the new version, so its URL serves the new code.
 *
 * Script and deployment IDs are never printed: they are redacted from clasp's output
 * and from error messages. Node built-ins only.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENVS = ['test', 'prod'];
const ALLOW_BRANCH_FLAG = '--allow-branch';
const SCRIPT_ID_PATTERN = /^[\w-]{20,}$/;
const DEPLOYMENT_ID_PATTERN = /^[\w-]{10,}$/;
const PLACEHOLDER_PREFIX = 'PASTE_';
const REDACTED = '<deployment-id>';

function log(message) {
  console.log(`[push] ${message}`);
}

function usage() {
  return [
    'Usage: node scripts/push.js <test|prod> [--allow-branch]',
    '  test             push to the TEST project (.clasp-test.json)',
    '  prod             push to the PROD project (.clasp-prod.json); needs master and a clean tree',
    '  --allow-branch   allow PROD to be pushed from a branch other than master'
  ].join('\n');
}

/** Replaces every occurrence of each secret with a placeholder. */
function redact(text, secrets) {
  return secrets.reduce((out, secret) => out.split(secret).join(REDACTED), String(text));
}

/** Runs git from the repo root and returns its trimmed stdout. Throws when git fails. */
function readGit(args) {
  try {
    return execSync(`git ${args}`, {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true, encoding: 'utf8'
    }).trim();
  } catch (err) {
    throw new Error(`Could not read git state (git ${args}). Is git installed and is this a git repository?`);
  }
}

/** PROD guard: master branch and a clean working tree, unless --allow-branch is given. */
function assertProdAllowed() {
  const branch = readGit('rev-parse --abbrev-ref HEAD');
  if (branch !== 'master') {
    throw new Error(`Refusing to push PROD from branch '${branch}'. ` +
      'Switch to master (after merging develop) or pass --allow-branch.');
  }
  if (readGit('status --porcelain') !== '') {
    throw new Error('Refusing to push PROD with uncommitted changes.');
  }
}

/**
 * Reads .clasp-<env>.json and checks it holds a plausible Script ID. The ID is never printed.
 * @return {string} Path of the source file.
 */
function checkClaspSource(env) {
  const source = path.join(ROOT, `.clasp-${env}.json`);
  if (!fs.existsSync(source)) {
    throw new Error(`Missing .clasp-${env}.json. Copy .clasp.example.json to .clasp-${env}.json ` +
      `and paste that project's Script ID.`);
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch (err) {
    throw new Error(`.clasp-${env}.json is not valid JSON.`);
  }
  const id = config && config.scriptId;
  if (typeof id !== 'string' || id.startsWith(PLACEHOLDER_PREFIX) || !SCRIPT_ID_PATTERN.test(id)) {
    throw new Error(`.clasp-${env}.json has no valid scriptId. Paste that project's Script ID.`);
  }
  return source;
}

/**
 * Returns the web app deployment ID for this env from .deploy.json, or null when it is
 * absent or unusable (the example file's PASTE_ placeholders are treated as absent).
 */
function readDeploymentId(env) {
  const file = path.join(ROOT, '.deploy.json');
  if (!fs.existsSync(file)) {
    return null;
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log('.deploy.json is not valid JSON, so the web app deployment will not be updated.');
    return null;
  }
  const id = config && config[env];
  if (typeof id !== 'string' || id.startsWith(PLACEHOLDER_PREFIX) || !DEPLOYMENT_ID_PATTERN.test(id)) {
    log(`.deploy.json has no valid "${env}" deployment ID, so the web app deployment will not be updated.`);
    return null;
  }
  return id;
}

function warnCodeOnly(env) {
  log(`WARNING: only the code was pushed to ${env.toUpperCase()}. The web app deployment was NOT updated,`);
  log('so the web app URL keeps serving the previous version.');
  log('To enable the update: copy .deploy.example.json to .deploy.json and paste the');
  log(`"${env}" web app deployment ID (Apps Script -> Deploy -> Manage deployments).`);
}

/** Moves the existing web app deployment to the newest version. Output is captured and redacted. */
function updateDeployment(env, deploymentId) {
  const description = `${env} ${new Date().toISOString()}`;
  const command = `clasp deploy -i ${deploymentId} -d "${description}"`;
  try {
    execSync(command, { cwd: ROOT, stdio: 'pipe', shell: true, encoding: 'utf8' });
  } catch (err) {
    const output = redact(`${err.stdout || ''}${err.stderr || ''}`.trim(), [deploymentId]);
    throw new Error(`Deployment update failed (${env}, exit ${err.status}).` + (output ? ` ${output}` : ''));
  }
  log(`Deployment updated (${env}).`);
}

function main(args) {
  const env = args[0];
  const extra = args.slice(1).filter((arg) => arg !== ALLOW_BRANCH_FLAG);
  if (!ENVS.includes(env) || extra.length > 0) {
    throw new Error(usage());
  }
  const allowBranch = args.includes(ALLOW_BRANCH_FLAG);

  if (env === 'prod' && !allowBranch) {
    log('Checking the PROD guard (branch and clean tree)...');
    assertProdAllowed();
  }

  log(`Using .clasp-${env}.json.`);
  const source = checkClaspSource(env);
  fs.copyFileSync(source, path.join(ROOT, '.clasp.json'));

  log(`Pushing to ${env.toUpperCase()}...`);
  execSync('clasp push -f', { cwd: ROOT, stdio: 'inherit', shell: true });

  const deploymentId = readDeploymentId(env);
  if (!deploymentId) {
    warnCodeOnly(env);
    return;
  }
  updateDeployment(env, deploymentId);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(`[push] ${err.message}`);
  process.exitCode = 1;
}
