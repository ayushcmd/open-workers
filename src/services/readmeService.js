import path from 'node:path';
import {
  smartUpdateReadme,
  updateReadmeLicense,
  inspectReadme,
  README_PLACEMENTS,
  BADGE_ACTIONS,
  SECTION_ACTIONS
} from '../../public/js/readme.js';
import { ServiceError } from './licenseService.js';

export { inspectReadme, README_PLACEMENTS, BADGE_ACTIONS, SECTION_ACTIONS };

/**
 * Fetch and decode the repository README from GitHub.
 *
 * @param {object} octokit
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} [params.ref]
 * @returns {Promise<{ exists: boolean, path: string, sha: string|null, content: string }>}
 */
export async function fetchRepositoryReadme(octokit, { owner, repo, ref }) {
  let file;
  try {
    const res = await octokit.rest.repos.getReadme({ owner, repo, ...(ref ? { ref } : {}) });
    file = res.data;
  } catch (err) {
    if (err.status === 404) {
      return { exists: false, path: 'README.md', sha: null, content: '' };
    }
    throw new ServiceError(502, `Unable to read repository README: ${err.message}`, 'README_READ_FAILED');
  }

  if (
    file &&
    (!/\.(md|markdown)$/i.test(file.path || '') ||
      file.type !== 'file' ||
      file.encoding !== 'base64' ||
      typeof file.content !== 'string' ||
      !file.sha)
  ) {
    throw new ServiceError(
      409,
      'README updates require a readable Markdown file. Choose "Do not change README" to continue without editing it.',
      'UNSUPPORTED_README'
    );
  }

  const filename = file?.path || 'README.md';
  const original = file ? Buffer.from(file.content, 'base64').toString('utf8') : '';
  return {
    exists: true,
    path: filename,
    sha: file.sha,
    content: original
  };
}

/**
 * Prepare proposed README content for PR creation with SHA safety and conflict detection.
 *
 * @param {object} octokit
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} params.ref
 * @param {object} params.license { id, name }
 * @param {string} params.licensePath
 * @param {string} [params.placement='both']
 * @param {string} [params.badgeAction]
 * @param {string} [params.sectionAction]
 * @param {string} [params.customReadmeContent]
 * @param {string} [params.expectedSha]
 * @returns {Promise<object|null>}
 */
export async function prepareReadmeUpdate(
  octokit,
  {
    owner,
    repo,
    ref,
    license,
    licensePath,
    placement = 'both',
    badgeAction,
    sectionAction,
    customReadmeContent,
    expectedSha
  }
) {
  if (placement === 'none' && !customReadmeContent && !badgeAction && !sectionAction) {
    return null;
  }

  if (customReadmeContent !== undefined) {
    if (typeof customReadmeContent !== 'string') {
      throw new ServiceError(400, 'customReadmeContent must be a string.', 'INVALID_INPUT');
    }
    if (Buffer.byteLength(customReadmeContent, 'utf8') > 1024 * 1024) {
      throw new ServiceError(400, 'Custom README content exceeds maximum allowed size (1MB).', 'INVALID_INPUT');
    }
  }

  const readmeData = await fetchRepositoryReadme(octokit, { owner, repo, ref });
  const filename = readmeData.path;
  const original = readmeData.content;

  // Enforce expected SHA to prevent stale overwrites
  if (expectedSha !== undefined && expectedSha !== null) {
    if (readmeData.exists && readmeData.sha !== expectedSha) {
      throw new ServiceError(
        409,
        `Repository README has been modified since it was inspected (expected blob ${expectedSha}, found ${readmeData.sha}). Refresh the preview before proceeding.`,
        'README_STALE',
        { expectedSha, actualSha: readmeData.sha }
      );
    }
    if (!readmeData.exists && expectedSha !== '') {
      throw new ServiceError(
        409,
        'Repository README was expected to exist but was not found. Refresh before proceeding.',
        'README_STALE'
      );
    }
  }

  const link = path.posix.relative(path.posix.dirname(filename), licensePath);
  let content;

  if (typeof customReadmeContent === 'string') {
    content = customReadmeContent;
  } else if (badgeAction || sectionAction) {
    content = smartUpdateReadme(original, {
      license,
      licenseLink: link,
      badgeAction,
      sectionAction,
      placement
    });
  } else {
    // Legacy fallback
    content = updateReadmeLicense(original, license, placement, link);
  }

  const inspection = inspectReadme(original, license.id);

  return {
    path: filename,
    sha: readmeData.sha,
    content,
    originalContent: original,
    changed: content !== original,
    isNew: !readmeData.exists,
    inspection,
    // Preserve custom attribution and flag it for review instead of rewriting it.
    reviewExisting: /licen[cs]e|shields\.io\/badge\/licen[cs]e/i.test(
      original.replace(
        /<!-- (?:open-workers|license-advisor|open-license-advisor):(top|bottom):start -->[\s\S]*?<!-- (?:open-workers|license-advisor|open-license-advisor):\1:end -->/g,
        ''
      )
    )
  };
}
