import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createGitHubContext } from '../src/config/github.js';
import { isBotSender } from '../src/core/events/idempotency.js';
import { updateReadmeLicense } from '../public/js/readme.js';
import { LICENSE_CATALOG } from '../public/js/catalog-data.js';

describe('Open Workers v2.0.0 Release & Branding Verification', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.resolve('package-lock.json'), 'utf8'));
  const apache = LICENSE_CATALOG.find((l) => l.id === 'Apache-2.0');

  it('enforces v2.0.0 consistency across package.json and package-lock.json', () => {
    assert.strictEqual(packageJson.name, 'open-workers');
    assert.strictEqual(packageJson.version, '2.0.0');
    assert.strictEqual(packageLock.name, 'open-workers');
    assert.strictEqual(packageLock.version, '2.0.0');
    assert.strictEqual(packageLock.packages[''].version, '2.0.0');
  });

  it('defaults GitHub App context slug to open-workers and generates verified installation URLs', () => {
    const ctx = createGitHubContext({}, { silent: true });
    assert.strictEqual(ctx.appSlug, 'open-workers');
    assert.strictEqual(
      ctx.getInstallationUrl(),
      'https://github.com/apps/open-workers/installations/new'
    );
  });

  it('allows custom GITHUB_APP_SLUG override without breaking URL format', () => {
    const ctx = createGitHubContext(
      { GITHUB_APP_SLUG: 'custom-enterprise-worker' },
      { silent: true }
    );
    assert.strictEqual(ctx.appSlug, 'custom-enterprise-worker');
    assert.strictEqual(
      ctx.getInstallationUrl(),
      'https://github.com/apps/custom-enterprise-worker/installations/new'
    );
  });

  it('safely detects bots for loop prevention while maintaining backward-compatible aliases', () => {
    // Current primary bot
    assert.strictEqual(isBotSender({ type: 'Bot', login: 'open-workers[bot]' }), true);
    assert.strictEqual(isBotSender({ type: 'User', login: 'open-workers[bot]' }), true);

    // Legacy aliases preserved for event idempotency
    assert.strictEqual(isBotSender({ type: 'User', login: 'open-license-advisor[bot]' }), true);
    assert.strictEqual(isBotSender({ type: 'User', login: 'license-advisor[bot]' }), true);

    // Any standard bot
    assert.strictEqual(isBotSender({ type: 'Bot', login: 'dependabot[bot]' }), true);
    assert.strictEqual(isBotSender({ type: 'User', login: 'github-actions[bot]' }), true);

    // Human users are not flagged as bots
    assert.strictEqual(isBotSender({ type: 'User', login: 'ayushcmd' }), false);
    assert.strictEqual(isBotSender({ type: 'User', login: 'octocat' }), false);
    assert.strictEqual(isBotSender(null), false);
    assert.strictEqual(isBotSender({}), false);
  });

  it('generates canonical open-workers README markers on new files', () => {
    const original = '# New Project\n\nSome introductory content.\n';
    const updated = updateReadmeLicense(original, apache, 'both', 'LICENSE');

    assert.ok(updated.includes('<!-- open-workers:top:start -->'));
    assert.ok(updated.includes('<!-- open-workers:top:end -->'));
    assert.ok(updated.includes('<!-- open-workers:bottom:start -->'));
    assert.ok(updated.includes('<!-- open-workers:bottom:end -->'));
    assert.ok(updated.includes('[![License: Apache-2.0]'));
    assert.ok(updated.includes('## License'));
  });

  it('cleans and replaces both open-license-advisor and license-advisor legacy markers without duplicate sections', () => {
    const multiLegacy = [
      '<!-- open-license-advisor:top:start -->',
      '[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)',
      '<!-- open-license-advisor:top:end -->',
      '# Hybrid Project',
      '',
      '<!-- license-advisor:bottom:start -->',
      '## License',
      'Licensed under MIT.',
      '<!-- license-advisor:bottom:end -->'
    ].join('\n');

    const updated = updateReadmeLicense(multiLegacy, apache, 'both', 'LICENSE');

    assert.strictEqual(updated.includes('open-license-advisor'), false);
    assert.strictEqual(updated.includes('license-advisor'), false);
    assert.ok(updated.includes('<!-- open-workers:top:start -->'));
    assert.ok(updated.includes('<!-- open-workers:bottom:start -->'));
    assert.strictEqual((updated.match(/## License/g) || []).length, 1);
  });
});
