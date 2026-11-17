#!/usr/bin/env node
'use strict';

/**
 * Deploy helper for the Apps Script project (`npm run push`).
 *
 * 1. `clasp push -f` uploads the root Apps Script files.
 * 2. If `.deploy.json` holds a web app deployment ID, `clasp deploy -i <id>`
 *    moves that existing deployment to the new version, so its URL serves
 *    the new code.
 *
 * The deployment ID is never printed: it is redacted from clasp's output and
 * from error messages. Node built-ins only.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEPLOY_FILE = path.join(ROOT, '.deploy.json');
const DEPLOYMENT_ID_PATTERN = /^[\w-]{10,}$/;
const REDACTED = '[deployment-id]';

function log(message) {
  console.log(`[push] ${message}`);
}

function redact(text, secrets) {
  return secrets.reduce((out, secret) => out.split(secret).join(REDACTED), String(text));
}

/**
 * Runs `clasp <args>` from the repo root. With `inherit`, clasp writes straight
 * to the terminal. Otherwise its output is captured, redacted and printed.
 * Throws when clasp exits non-zero.
 */
function runClasp(args, { inherit = false, secrets = [] } = {}) {
  const command = `clasp ${args.join(' ')}`;
  log(`running: ${redact(command, secrets)}`);
  try {
    if (inherit) {
      execSync(command, { cwd: ROOT, stdio: 'inherit', shell: true });
      return;
    }
    const output = execSync(command, { cwd: ROOT, stdio: 'pipe', shell: true, encoding: 'utf8' });
    process.stdout.write(redact(output, secrets));
  } catch (err) {
    process.stdout.write(redact(err.stdout || '', secrets));
    process.stderr.write(redact(err.stderr || '', secrets));
    throw new Error(`command failed (exit ${err.status}): ${redact(command, secrets)}`);
  }
}

/** Returns the deployment ID from `.deploy.json`, or null when it is absent or malformed. */
function readDeploymentId() {
  if (!fs.existsSync(DEPLOY_FILE)) {
    return null;
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(DEPLOY_FILE, 'utf8'));
  } catch (err) {
    log('.deploy.json is not valid JSON, so the web app deployment will not be updated.');
    return null;
  }
  const id = config && config.deploymentId;
  if (typeof id !== 'string' || !DEPLOYMENT_ID_PATTERN.test(id)) {
    log('.deploy.json has no valid deploymentId, so the web app deployment will not be updated.');
    return null;
  }
  return id;
}

function warnCodeOnly() {
  log('WARNING: only the code was pushed. The web app deployment was NOT updated,');
  log('so the phone app keeps serving the previous version.');
  log('To enable the update: copy .deploy.example.json to .deploy.json and paste the');
  log('web app deployment ID (Apps Script -> Deploy -> Manage deployments).');
}

function main() {
  runClasp(['push', '-f'], { inherit: true });

  const deploymentId = readDeploymentId();
  if (!deploymentId) {
    warnCodeOnly();
    return;
  }

  const description = `"${new Date().toISOString()}"`;
  runClasp(['deploy', '-i', deploymentId, '-d', description], { secrets: [deploymentId] });
  log('Code pushed and the web app deployment now serves the new version.');
}

try {
  main();
} catch (err) {
  console.error(`[push] ${err.message}`);
  process.exitCode = 1;
}
