import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LICENSE_CATALOG } from '../public/js/catalog-data.js';
import {
  detectLicenseBadges,
  detectBadgeGroup,
  detectLicenseSections,
  inspectReadme,
  smartUpdateReadme,
  generateUnifiedDiff,
  renderSafeMarkdown
} from '../public/js/readme.js';
import { prepareReadmeUpdate, fetchRepositoryReadme } from '../src/services/readmeService.js';
import {
  createLicensePullRequest,
  previewLicensePullRequest,
  formatLicenseBranchName
} from '../src/services/prService.js';
import { createApp } from '../src/server.js';
import { encryptSession } from '../src/core/auth/session.js';

const apache = LICENSE_CATALOG.find((l) => l.id === 'Apache-2.0');
const mit = LICENSE_CATALOG.find((l) => l.id === 'MIT');

// Realistic fixture modeled after ayushcmd/dollar-hegemony
const DOLLAR_HEGEMONY_FIXTURE = [
  '# Dollar Hegemony  ',
  '## Quantifying USD Dominance Across BRICS vs G7 with DSI, XGBoost, and LSTM',
  '',
  '[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)',
  '[![Plotly Dash](https://img.shields.io/badge/Frontend-Plotly%20Dash-3F4F75)](https://plotly.com/dash/)',
  '[![FastAPI](https://img.shields.io/badge/API-FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)',
  '[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)',
  '[![Models](https://img.shields.io/badge/Models-XGBoost%20%7C%20LSTM-orange)](#modeling-framework)',
  '[![Hugging Face Space](https://img.shields.io/badge/Live%20Demo-HuggingFace-FFD21E?logo=huggingface&logoColor=black)](https://huggingface.co/spaces/Ayush0826/dollar-hegemony)',
  '',
  'An interactive macro-financial ML research system.',
  '',
  '## Citation',
  '',
  'If you use this project, cite Ayush Raj - Dollar Hegemony.',
  '',
  '## License',
  '',
  'Licensed under [MIT License](LICENSE).'
].join('\n');

describe('Smart README Editor & Conflict Handling (Issue #30)', () => {
  // Case 1: Existing badge row -> replace license badge in place
  it('1. replaces license badge in place inside an existing badge row without adding above title', () => {
    const updated = smartUpdateReadme(DOLLAR_HEGEMONY_FIXTURE, {
      license: apache,
      licenseLink: 'LICENSE',
      badgeAction: 'update_badge'
    });

    // Badge should be updated to Apache-2.0
    assert.ok(updated.includes('License-Apache--2.0-blue.svg'));
    // Old MIT badge should be gone
    assert.strictEqual(updated.includes('License-MIT-blue.svg'), false);

    // Unrelated badges must be preserved in place
    assert.ok(updated.includes('Python-3.10%2B-3776AB'));
    assert.ok(updated.includes('API-FastAPI-009688'));
    assert.ok(updated.includes('Models-XGBoost'));

    // Badge must not be placed above the # Dollar Hegemony title
    assert.ok(updated.startsWith('# Dollar Hegemony  '));
  });

  // Case 2: Existing MIT section -> replace with Apache-2.0 wording
  it('2. replaces existing MIT section with Apache-2.0 wording preserving adjacent sections', () => {
    const updated = smartUpdateReadme(DOLLAR_HEGEMONY_FIXTURE, {
      license: apache,
      licenseLink: 'LICENSE',
      sectionAction: 'update_section'
    });

    // License section should mention Apache License 2.0
    assert.ok(updated.includes('Licensed under [Apache License 2.0](LICENSE).'));
    assert.strictEqual(updated.includes('[MIT License](LICENSE)'), false);

    // Citation section must remain completely intact
    assert.ok(updated.includes('## Citation\n\nIf you use this project, cite Ayush Raj - Dollar Hegemony.'));

    // Exactly one ## License heading
    const licenseHeadings = (updated.match(/## License/g) || []).length;
    assert.strictEqual(licenseHeadings, 1);
  });

  // Case 3: Existing matching Apache-2.0 section -> avoid duplicates
  it('3. avoids duplicate license sections when README already uses the selected license', () => {
    const apacheReadme = DOLLAR_HEGEMONY_FIXTURE.replace('MIT', 'Apache-2.0');
    const updated = smartUpdateReadme(apacheReadme, {
      license: apache,
      licenseLink: 'LICENSE',
      sectionAction: 'update_section'
    });

    const licenseHeadings = (updated.match(/## License/g) || []).length;
    assert.strictEqual(licenseHeadings, 1);
  });

  // Case 4: Missing README -> new README handling
  it('4. proposes new README with canonical markers when repository has no README', () => {
    const updated = smartUpdateReadme('', {
      license: apache,
      licenseLink: 'LICENSE',
      badgeAction: 'insert_top',
      sectionAction: 'add_section'
    });

    assert.ok(updated.includes('<!-- open-workers:top:start -->'));
    assert.ok(updated.includes('<!-- open-workers:bottom:start -->'));
    assert.ok(updated.includes('[Apache License 2.0](LICENSE)'));
  });

  // Case 5: Missing LICENSE -> add action
  it('5. identifies missing LICENSE as an "add" action', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: 'main', archived: false } }),
          getContent: async () => ({ data: [] }),
          getReadme: async () => ({
            data: { type: 'file', path: 'README.md', sha: 'sha-readme', encoding: 'base64', content: Buffer.from('# App').toString('base64') }
          })
        },
        licenses: { getForRepo: async () => { const err = new Error('Not found'); err.status = 404; throw err; } }
      }
    };

    const preview = await previewLicensePullRequest({
      repo: 'mock/repo',
      licenseId: 'MIT',
      holder: 'Test Org',
      githubContext: { isAppConfigured: true, resolveRepoInstallation: async () => ({ installed: true, octokit: mockOctokit }) }
    });

    assert.strictEqual(preview.license.action, 'add');
    assert.strictEqual(preview.conflicts.length, 0);
  });

  // Case 6: Existing LICENSE -> reject unsafe add action
  it('6. rejects add action with conflict when LICENSE already exists', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: 'main', archived: false } }),
          getContent: async ({ path }) => {
            if (path === '') return { data: [{ type: 'file', name: 'LICENSE', path: 'LICENSE' }] };
            return { data: { type: 'file', sha: 'license-sha-123' } };
          },
          getReadme: async () => ({
            data: { type: 'file', path: 'README.md', sha: 'sha-readme', encoding: 'base64', content: Buffer.from('# App').toString('base64') }
          })
        },
        licenses: { getForRepo: async () => ({ data: { path: 'LICENSE', license: { spdx_id: 'MIT' } } }) }
      }
    };

    const preview = await previewLicensePullRequest({
      repo: 'mock/repo',
      licenseId: 'Apache-2.0',
      holder: 'Test Org',
      replaceExisting: false,
      githubContext: { isAppConfigured: true, resolveRepoInstallation: async () => ({ installed: true, octokit: mockOctokit }) }
    });

    const hasConflict = preview.conflicts.some((c) => c.type === 'license_exists');
    assert.strictEqual(hasConflict, true);
  });

  // Case 7: Multiple License headings -> ambiguity warning
  it('7. detects multiple License headings and emits ambiguity warning', () => {
    const ambiguousReadme = [
      '# Ambiguous Project',
      '',
      '## License',
      'Short notice.',
      '',
      '## Usage',
      'How to use.',
      '',
      '## Licensing Information',
      'Detailed licensing terms.'
    ].join('\n');

    const inspection = inspectReadme(ambiguousReadme, 'Apache-2.0');
    assert.strictEqual(inspection.isAmbiguous, true);
    assert.ok(inspection.warnings.some((w) => w.includes('Multiple License headings')));
  });

  // Case 8: README heading hierarchy preservation
  it('8. preserves custom heading level (e.g. ### License) when updating in place', () => {
    const h3Readme = '# Title\n\n### License\n\nLicensed under [MIT](LICENSE).\n\n## Next Section';
    const updated = smartUpdateReadme(h3Readme, {
      license: apache,
      sectionAction: 'update_section'
    });

    assert.ok(updated.includes('### License\n\nLicensed under [Apache License 2.0](LICENSE).'));
    assert.ok(updated.includes('## Next Section'));
  });

  // Case 9: Markdown and HTML badge detection
  it('9. detects Markdown and HTML license badges accurately', () => {
    const mixedBadges = [
      '[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)',
      '<a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" alt="License"></a>',
      '[![CI](https://img.shields.io/badge/CI-passing-green.svg)](https://example.com)'
    ].join('\n');

    const badges = detectLicenseBadges(mixedBadges);
    assert.strictEqual(badges.length, 2);
    assert.strictEqual(badges[0].detectedLicense, 'MIT');
    assert.strictEqual(badges[1].detectedLicense, 'Apache-2.0');
  });

  // Case 10: Existing legacy generated blocks
  it('10. replaces legacy license-advisor markers with canonical open-workers markers', () => {
    const legacy = [
      '<!-- license-advisor:top:start -->',
      '[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)',
      '<!-- license-advisor:top:end -->',
      '# Project'
    ].join('\n');

    const updated = smartUpdateReadme(legacy, {
      license: apache,
      badgeAction: 'insert_top'
    });

    assert.strictEqual(updated.includes('<!-- license-advisor:'), false);
    assert.ok(updated.includes('<!-- open-workers:top:start -->'));
    assert.ok(updated.includes('License-Apache--2.0-blue.svg'));
  });

  // Case 11: Full Markdown editing
  it('11. honors custom Markdown content from Advanced Editor mode', () => {
    const custom = '# Fully Customized README\n\nAuthored manually by user.';
    const updated = smartUpdateReadme(DOLLAR_HEGEMONY_FIXTURE, {
      license: apache,
      customReadmeContent: custom
    });

    assert.strictEqual(updated, custom);
  });

  // Case 12: Reset and Guided proposal behavior
  it('12. allows resetting to original and restoring guided proposal cleanly', () => {
    const original = DOLLAR_HEGEMONY_FIXTURE;
    const guided = smartUpdateReadme(original, { license: apache, badgeAction: 'update_badge', sectionAction: 'update_section' });

    // Custom edit
    const edited = smartUpdateReadme(original, { license: apache, customReadmeContent: '# Hand Crafted' });
    assert.strictEqual(edited, '# Hand Crafted');

    // Resetting to original
    const reset = original;
    assert.ok(reset.includes('License-MIT-blue.svg'));

    // Restoring guided proposal
    assert.ok(guided.includes('License-Apache--2.0-blue.svg'));
  });

  // Case 13: Accurate before/after diff
  it('13. generates unified diff reflecting exact license changes', () => {
    const original = '# Title\n\n[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)\n';
    const proposed = '# Title\n\n[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)\n';

    const diff = generateUnifiedDiff(original, proposed, 'README.md');
    assert.ok(diff.includes('--- a/README.md'));
    assert.ok(diff.includes('+++ b/README.md'));
    assert.ok(diff.includes('-'));
    assert.ok(diff.includes('+'));
    assert.ok(diff.includes('License-Apache--2.0-blue.svg'));
  });

  // Case 14: Unsafe HTML and JavaScript Markdown previews
  it('14. neutralizes XSS payloads (script, onerror, javascript:) in rendered preview', () => {
    const malicious = [
      '# XSS Test',
      '<script>alert("pwned")</script>',
      '<img src="x" onerror="alert(1)">',
      '[Click Me](javascript:alert(document.cookie))',
      '<iframe src="https://evil.com"></iframe>'
    ].join('\n');

    const rendered = renderSafeMarkdown(malicious);
    assert.strictEqual(rendered.includes('<script>'), false);
    assert.strictEqual(rendered.includes('onerror='), false);
    assert.strictEqual(rendered.includes('javascript:'), false);
    assert.strictEqual(rendered.includes('<iframe'), false);
    assert.ok(rendered.includes('<h1>XSS Test</h1>'));
  });

  // Case 15: Repository write authorization
  it('15. rejects PR creation when user lacks write permission', async () => {
    const secretKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const sessionToken = encryptSession({ login: 'reader', token: 'user-token' }, secretKey);

    const mockOctokit = {
      rest: {
        repos: {
          getCollaboratorPermissionLevel: async () => ({ data: { permission: 'read' } }),
          get: async () => ({ data: { default_branch: 'main', archived: false } })
        }
      }
    };

    const { app } = createApp({
      env: { SESSION_SECRET: secretKey },
      githubContext: {
        sessionSecret: secretKey,
        isAppConfigured: true,
        resolveRepoInstallation: async () => ({ installed: true, octokit: mockOctokit })
      },
      createUserClient: () => ({ rest: { users: { getAuthenticated: async () => ({ data: { login: 'reader', type: 'User' } }) } } })
    });

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/trigger-pr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `ow_session=${sessionToken}`
        },
        body: JSON.stringify({
          repo: 'mock/repo',
          licenseId: 'MIT'
        })
      });

      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.ok(data.error.toLowerCase().includes('write'));
    } finally {
      server.close();
    }
  });

  // Case 16: Stale README/Licensing SHAs
  it('16. rejects PR creation with 409 README_STALE when expected README SHA does not match', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          getReadme: async () => ({
            data: { type: 'file', path: 'README.md', sha: 'sha-latest-modified', encoding: 'base64', content: Buffer.from('# App').toString('base64') }
          })
        }
      }
    };

    await assert.rejects(
      prepareReadmeUpdate(mockOctokit, {
        owner: 'mock',
        repo: 'repo',
        ref: 'main',
        license: apache,
        licensePath: 'LICENSE',
        expectedSha: 'sha-outdated-inspected'
      }),
      (err) => err.code === 'README_STALE' && err.statusCode === 409
    );
  });

  // Case 17: Concurrent repository updates
  it('17. detects concurrent repository modification via SHA guardrail', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: 'main', archived: false } }),
          getContent: async ({ path }) => {
            if (path === '') return { data: [{ type: 'file', name: 'LICENSE', path: 'LICENSE' }] };
            return { data: { type: 'file', sha: 'license-sha-concurrently-updated' } };
          },
          getReadme: async () => ({
            data: { type: 'file', path: 'README.md', sha: 'readme-sha-concurrently-updated', encoding: 'base64', content: Buffer.from('# App').toString('base64') }
          }),
          getCollaboratorPermissionLevel: async () => ({ data: { permission: 'write' } })
        },
        git: {
          getRef: async () => ({ data: { object: { sha: 'base-sha-1' } } })
        },
        licenses: { getForRepo: async () => ({ data: { path: 'LICENSE' } }) }
      }
    };

    const githubContext = {
      isAppConfigured: true,
      resolveRepoInstallation: async () => ({ installed: true, octokit: mockOctokit })
    };

    await assert.rejects(
      createLicensePullRequest({
        repo: 'mock/repo',
        licenseId: 'Apache-2.0',
        holder: 'Test Org',
        replaceExisting: true,
        expectedLicenseSha: 'license-sha-stale',
        githubContext
      }),
      (err) => err.code === 'LICENSE_STALE' && err.statusCode === 409
    );
  });

  // Case 18: Preview/create payload consistency
  it('18. guarantees preview proposed content matches created PR content', async () => {
    const readmeContent = '# My Tool\n\n[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)\n\n## License\n\nMIT License.';
    const mockOctokit = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: 'main', archived: false } }),
          getContent: async ({ path }) => {
            if (path === '') return { data: [{ type: 'file', name: 'LICENSE', path: 'LICENSE' }] };
            return { data: { type: 'file', sha: 'license-sha-1' } };
          },
          getReadme: async () => ({
            data: { type: 'file', path: 'README.md', sha: 'readme-sha-1', encoding: 'base64', content: Buffer.from(readmeContent).toString('base64') }
          })
        },
        licenses: { getForRepo: async () => ({ data: { path: 'LICENSE' } }) }
      }
    };

    const preview = await previewLicensePullRequest({
      repo: 'mock/repo',
      licenseId: 'Apache-2.0',
      holder: 'Test Org',
      replaceExisting: true,
      badgeAction: 'update_badge',
      sectionAction: 'update_section',
      githubContext: { isAppConfigured: true, resolveRepoInstallation: async () => ({ installed: true, octokit: mockOctokit }) }
    });

    const directUpdate = await prepareReadmeUpdate(mockOctokit, {
      owner: 'mock',
      repo: 'repo',
      ref: 'main',
      license: apache,
      licensePath: 'LICENSE',
      badgeAction: 'update_badge',
      sectionAction: 'update_section',
      expectedSha: 'readme-sha-1'
    });

    assert.strictEqual(preview.readme.proposedContent, directUpdate.content);
  });

  // Case 19: No changes to unrelated README sections
  it('19. keeps all unrelated README sections intact when updating license in place', () => {
    const complexReadme = [
      '# Super System',
      '',
      '[![Build](https://img.shields.io/badge/build-passing-green.svg)](https://example.com)',
      '[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)',
      '',
      '## Overview',
      'Complex overview paragraph.',
      '',
      '## Architecture',
      'System design details.',
      '',
      '## Installation',
      'npm install super-system',
      '',
      '## Citation',
      'Please cite this tool in papers.',
      '',
      '## Contributing',
      'See CONTRIBUTING.md for details.',
      '',
      '## License',
      'Licensed under MIT License.',
      '',
      '## Contact',
      'hello@example.com'
    ].join('\n');

    const updated = smartUpdateReadme(complexReadme, {
      license: apache,
      badgeAction: 'update_badge',
      sectionAction: 'update_section'
    });

    assert.ok(updated.includes('## Overview\nComplex overview paragraph.'));
    assert.ok(updated.includes('## Architecture\nSystem design details.'));
    assert.ok(updated.includes('## Installation\nnpm install super-system'));
    assert.ok(updated.includes('## Citation\nPlease cite this tool in papers.'));
    assert.ok(updated.includes('## Contributing\nSee CONTRIBUTING.md for details.'));
    assert.ok(updated.includes('## Contact\nhello@example.com'));
    assert.ok(updated.includes('Licensed under [Apache License 2.0](LICENSE).'));
  });

  // Case 20: No direct default-branch commits
  it('20. commits only to isolated feature branches and never to the default branch', async () => {
    const committedBranches = [];
    const mockOctokit = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: 'main', archived: false } }),
          getContent: async ({ path }) => {
            if (path === '') return { data: [] };
            const err = new Error('Not found'); err.status = 404; throw err;
          },
          getReadme: async () => ({
            data: { type: 'file', path: 'README.md', sha: 'readme-sha', encoding: 'base64', content: Buffer.from('# App').toString('base64') }
          }),
          getCollaboratorPermissionLevel: async () => ({ data: { permission: 'write' } }),
          createOrUpdateFileContents: async ({ branch }) => {
            committedBranches.push(branch);
            return { data: { commit: { sha: 'sha-new' } } };
          }
        },
        git: {
          getRef: async () => ({ data: { object: { sha: 'main-base-sha' } } }),
          createRef: async ({ ref }) => ({ data: { ref } })
        },
        pulls: {
          list: async () => ({ data: [] }),
          create: async ({ head, base }) => ({
            data: { number: 101, html_url: 'https://github.com/mock/repo/pull/101', head, base }
          })
        },
        licenses: { getForRepo: async () => { const err = new Error('Not found'); err.status = 404; throw err; } }
      }
    };

    const result = await createLicensePullRequest({
      repo: 'mock/repo',
      licenseId: 'Apache-2.0',
      holder: 'Test Org',
      readmePlacement: 'both',
      githubContext: { isAppConfigured: true, resolveRepoInstallation: async () => ({ installed: true, octokit: mockOctokit }) }
    });

    assert.strictEqual(result.baseBranch, 'main');
    assert.ok(result.branch.startsWith('chore/add-license-apache-2.0'));
    assert.ok(committedBranches.length > 0);
    // Every committed branch must be the feature branch, never 'main'
    for (const b of committedBranches) {
      assert.strictEqual(b, result.branch);
      assert.notStrictEqual(b, 'main');
    }
  });

  // Case 21: Private repository preview rejected when unauthenticated
  it('21. rejects preview-pr on private repository with 401 when unauthenticated', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: 'main', private: true, archived: false } })
        }
      }
    };

    const { app } = createApp({
      githubContext: {
        isAppConfigured: true,
        resolveRepoInstallation: async () => ({ installed: true, octokit: mockOctokit })
      }
    });

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/preview-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: 'mock/private-repo',
          licenseId: 'MIT',
          holder: 'Test Org'
        })
      });

      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.strictEqual(data.code, 'AUTH_REQUIRED');
      assert.ok(data.error.includes('Private repository'));
    } finally {
      server.close();
    }
  });

  // Case 22: Private repository preview rejected when user lacks read permission
  it('22. rejects preview-pr on private repository with 403 when user lacks read permission', async () => {
    const secretKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const sessionToken = encryptSession({ login: 'outsider', token: 'user-token' }, secretKey);

    const mockOctokit = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: 'main', private: true, archived: false } }),
          getCollaboratorPermissionLevel: async () => ({ data: { permission: 'none' } })
        }
      }
    };

    const { app } = createApp({
      env: { SESSION_SECRET: secretKey },
      githubContext: {
        sessionSecret: secretKey,
        isAppConfigured: true,
        resolveRepoInstallation: async () => ({ installed: true, octokit: mockOctokit })
      },
      createUserClient: () => ({
        rest: {
          users: { getAuthenticated: async () => ({ data: { login: 'outsider', type: 'User' } }) },
          repos: { get: async () => { const err = new Error('Not found'); err.status = 404; throw err; } }
        }
      })
    });

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/preview-pr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `ow_session=${sessionToken}`
        },
        body: JSON.stringify({
          repo: 'mock/private-repo',
          licenseId: 'MIT',
          holder: 'Test Org'
        })
      });

      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.code, 'FORBIDDEN');
    } finally {
      server.close();
    }
  });

  // Case 23: Private repository preview succeeds for authorized user
  it('23. succeeds for authorized user previewing a private repository', async () => {
    const secretKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const sessionToken = encryptSession({ login: 'collaborator', token: 'user-token' }, secretKey);

    const mockOctokit = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: 'main', private: true, archived: false } }),
          getContent: async ({ path }) => {
            if (path === '') return { data: [] };
            const err = new Error('Not found'); err.status = 404; throw err;
          },
          getReadme: async () => ({
            data: { type: 'file', path: 'README.md', sha: 'sha-priv-readme', encoding: 'base64', content: Buffer.from('# Private Project').toString('base64') }
          }),
          getCollaboratorPermissionLevel: async () => ({ data: { permission: 'read' } })
        },
        licenses: { getForRepo: async () => { const err = new Error('Not found'); err.status = 404; throw err; } }
      }
    };

    const { app } = createApp({
      env: { SESSION_SECRET: secretKey },
      githubContext: {
        sessionSecret: secretKey,
        isAppConfigured: true,
        resolveRepoInstallation: async () => ({ installed: true, octokit: mockOctokit })
      },
      createUserClient: () => ({
        rest: {
          users: { getAuthenticated: async () => ({ data: { login: 'collaborator', type: 'User' } }) }
        }
      })
    });

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/licensing/preview-pr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `ow_session=${sessionToken}`
        },
        body: JSON.stringify({
          repo: 'mock/private-repo',
          licenseId: 'Apache-2.0',
          holder: 'Test Org'
        })
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.readme.path, 'README.md');
      assert.ok(data.readme.proposedContent.includes('Apache License 2.0'));
    } finally {
      server.close();
    }
  });

  // Case 24: Public repository preview succeeds without user authentication
  it('24. allows public repository inspection without requiring authentication', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: 'main', private: false, archived: false } }),
          getContent: async () => ({ data: [] }),
          getReadme: async () => ({
            data: { type: 'file', path: 'README.md', sha: 'sha-pub-readme', encoding: 'base64', content: Buffer.from('# Public Repo').toString('base64') }
          })
        },
        licenses: { getForRepo: async () => { const err = new Error('Not found'); err.status = 404; throw err; } }
      }
    };

    const { app } = createApp({
      githubContext: {
        isAppConfigured: true,
        resolveRepoInstallation: async () => ({ installed: true, octokit: mockOctokit })
      }
    });

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/preview-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: 'mock/public-repo',
          licenseId: 'MIT',
          holder: 'Test Org'
        })
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.readme.path, 'README.md');
    } finally {
      server.close();
    }
  });

  // Case 25: Omitted confirmation in README workflow rejected with 400
  it('25. rejects PR creation with 400 CONFIRMATION_REQUIRED when confirmation is omitted in README workflow', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: 'main', archived: false } }),
          getContent: async () => ({ data: [] })
        }
      }
    };

    await assert.rejects(
      createLicensePullRequest({
        repo: 'mock/repo',
        licenseId: 'MIT',
        holder: 'Test Org',
        badgeAction: 'update_badge',
        sectionAction: 'update_section',
        // confirmed is omitted
        githubContext: { isAppConfigured: true, resolveRepoInstallation: async () => ({ installed: true, octokit: mockOctokit }) }
      }),
      (err) => err.statusCode === 400 && err.code === 'CONFIRMATION_REQUIRED'
    );
  });

  // Case 26: False confirmation rejected with 400
  it('26. rejects PR creation with 400 CONFIRMATION_REQUIRED when confirmed is false', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: 'main', archived: false } })
        }
      }
    };

    await assert.rejects(
      createLicensePullRequest({
        repo: 'mock/repo',
        licenseId: 'MIT',
        holder: 'Test Org',
        confirmed: false,
        githubContext: { isAppConfigured: true, resolveRepoInstallation: async () => ({ installed: true, octokit: mockOctokit }) }
      }),
      (err) => err.statusCode === 400 && err.code === 'CONFIRMATION_REQUIRED'
    );
  });

  // Case 27: Preview content mismatch guardrail
  it('27. rejects PR creation with 409 PREVIEW_CONTENT_MISMATCH when expectedReadmeContent does not match proposed', async () => {
    const readmeContent = '# My Tool\n\nExisting text.';
    const mockOctokit = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: 'main', archived: false } }),
          getContent: async () => ({ data: [] }),
          getReadme: async () => ({
            data: { type: 'file', path: 'README.md', sha: 'readme-sha-1', encoding: 'base64', content: Buffer.from(readmeContent).toString('base64') }
          })
        },
        git: {
          getRef: async () => ({ data: { object: { sha: 'base-sha-1' } } })
        },
        licenses: { getForRepo: async () => { const err = new Error('Not found'); err.status = 404; throw err; } }
      }
    };

    await assert.rejects(
      createLicensePullRequest({
        repo: 'mock/repo',
        licenseId: 'MIT',
        holder: 'Test Org',
        badgeAction: 'update_badge',
        sectionAction: 'update_section',
        confirmed: true,
        expectedReadmeSha: 'readme-sha-1',
        expectedReadmeContent: '# Tampered Content That Does Not Match',
        githubContext: { isAppConfigured: true, resolveRepoInstallation: async () => ({ installed: true, octokit: mockOctokit }) }
      }),
      (err) => err.statusCode === 409 && err.code === 'PREVIEW_CONTENT_MISMATCH'
    );
  });

  // Case 28: Matching confirmation and content succeeds
  it('28. succeeds when confirmed is true and expectedReadmeContent matches', async () => {
    const readmeContent = '# My Tool\n\nExisting text.';
    const committedFiles = [];
    const mockOctokit = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: 'main', archived: false } }),
          getContent: async () => ({ data: [] }),
          getReadme: async () => ({
            data: { type: 'file', path: 'README.md', sha: 'readme-sha-1', encoding: 'base64', content: Buffer.from(readmeContent).toString('base64') }
          }),
          createOrUpdateFileContents: async ({ path, content }) => {
            committedFiles.push({ path, content: Buffer.from(content, 'base64').toString('utf8') });
            return { data: { commit: { sha: 'commit-sha' } } };
          }
        },
        git: {
          getRef: async () => ({ data: { object: { sha: 'base-sha-1' } } }),
          createRef: async ({ ref }) => ({ data: { ref } })
        },
        pulls: {
          list: async () => ({ data: [] }),
          create: async ({ head, base }) => ({
            data: { number: 105, html_url: 'https://github.com/mock/repo/pull/105', head, base }
          })
        },
        licenses: { getForRepo: async () => { const err = new Error('Not found'); err.status = 404; throw err; } }
      }
    };

    // First generate the expected preview content
    const directUpdate = await prepareReadmeUpdate(mockOctokit, {
      owner: 'mock',
      repo: 'repo',
      ref: 'base-sha-1',
      license: mit,
      licensePath: 'LICENSE',
      badgeAction: 'insert_top',
      sectionAction: 'add_section'
    });

    const result = await createLicensePullRequest({
      repo: 'mock/repo',
      licenseId: 'MIT',
      holder: 'Test Org',
      badgeAction: 'insert_top',
      sectionAction: 'add_section',
      confirmed: true,
      expectedReadmeSha: 'readme-sha-1',
      expectedReadmeContent: directUpdate.content,
      githubContext: { isAppConfigured: true, resolveRepoInstallation: async () => ({ installed: true, octokit: mockOctokit }) }
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.pullNumber, 105);
    const committedReadme = committedFiles.find((f) => f.path === 'README.md');
    assert.ok(committedReadme);
    assert.strictEqual(committedReadme.content, directUpdate.content);
  });

  // Case 29: Duplicate license badge cleanup
  it('29. deduplicates multiple license badges and updates the primary one in place', () => {
    const multiBadgeReadme = [
      '# Project Header',
      '',
      '[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![License: BSD-3](https://img.shields.io/badge/License-BSD--3--Clause-blue.svg)](LICENSE)',
      '',
      'Body content here.'
    ].join('\n');

    const updated = smartUpdateReadme(multiBadgeReadme, {
      license: apache,
      badgeAction: 'update_badge'
    });

    // Should contain only one License badge
    const badgeMatches = updated.match(/img\.shields\.io\/badge\/License-/g) || [];
    assert.strictEqual(badgeMatches.length, 1);
    assert.ok(updated.includes('License-Apache--2.0-blue.svg'));
    assert.strictEqual(updated.includes('License-MIT'), false);
    assert.strictEqual(updated.includes('License-BSD'), false);

    // Also test: insert_badge_group when a license badge exists updates rather than duplicates
    const updatedViaInsertGroup = smartUpdateReadme(multiBadgeReadme, {
      license: apache,
      badgeAction: 'insert_badge_group'
    });
    const groupMatches = updatedViaInsertGroup.match(/img\.shields\.io\/badge\/License-/g) || [];
    assert.strictEqual(groupMatches.length, 1);
  });

  // Case 30: Duplicate license section cleanup
  it('30. cleans up duplicate license sections and updates the primary section', () => {
    const multiSectionReadme = [
      '# Dual License Header',
      '',
      'Introductory paragraph.',
      '',
      '## License',
      '',
      'Old MIT terms.',
      '',
      '## Other Section',
      '',
      'Important info.',
      '',
      '## License',
      '',
      'Duplicate obsolete license terms.'
    ].join('\n');

    const updated = smartUpdateReadme(multiSectionReadme, {
      license: apache,
      sectionAction: 'update_section'
    });

    const licenseSections = updated.match(/## License/g) || [];
    assert.strictEqual(licenseSections.length, 1);
    assert.ok(updated.includes('Licensed under [Apache License 2.0](LICENSE).'));
    assert.ok(updated.includes('## Other Section\n\nImportant info.'));
    assert.strictEqual(updated.includes('Old MIT terms.'), false);
    assert.strictEqual(updated.includes('Duplicate obsolete license terms.'), false);
  });
});
