/**
 * Open Workers — Smart README License Badge & Section Manager
 *
 * Provides intelligent, conflict-aware README inspection, badge management,
 * license section updating, and safe preview/diff generation.
 *
 * Guarantees:
 * 1. License badges join existing badge rows instead of appearing above titles.
 * 2. Existing ## License sections are updated in place, preventing duplicate headings.
 * 3. Conflicting license claims (e.g. MIT vs Apache-2.0) are detected and resolved.
 * 4. Backward-compatible with legacy <!-- license-advisor:... --> and <!-- open-workers:... --> markers.
 * 5. Safe HTML preview rendering free of XSS vectors.
 */

export const README_PLACEMENTS = ['none', 'top', 'bottom', 'both'];
export const BADGE_ACTIONS = ['update_badge', 'insert_badge_group', 'insert_top', 'none'];
export const SECTION_ACTIONS = ['update_section', 'add_section', 'keep_section', 'none'];

/**
 * Format standard badge and license section snippets for a given license.
 *
 * @param {object} license { id, name }
 * @param {string} [licenseLink='LICENSE']
 * @returns {{ top: string, bottom: string }}
 */
export function licenseReadmeSnippets(license, licenseLink = 'LICENSE') {
  const link = licenseLink
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/\(/g, '%28').replace(/\)/g, '%29'))
    .join('/');
  const badgeId = encodeURIComponent(license.id.replace(/-/g, '--').replace(/_/g, '__'));
  return {
    top: `[![License: ${license.id}](https://img.shields.io/badge/License-${badgeId}-blue.svg)](${link})`,
    bottom: `## License\n\n${license.id === 'Unlicense' ? 'Released into the public domain under' : 'Licensed under'} [${license.name}](${link}).`
  };
}

/**
 * Detect all license badges in README markdown.
 *
 * @param {string} content
 * @returns {Array<{ raw: string, startIndex: number, endIndex: number, type: string, detectedLicense: string|null }>}
 */
export function detectLicenseBadges(content) {
  if (!content || typeof content !== 'string') return [];
  const badges = [];

  // 1. Managed open-workers or license-advisor marker blocks
  const markerRegex = /<!-- (?:open-workers|license-advisor|open-license-advisor):top:start -->[\s\S]*?<!-- (?:open-workers|license-advisor|open-license-advisor):top:end -->/g;
  let match;
  while ((match = markerRegex.exec(content)) !== null) {
    const raw = match[0];
    const licMatch = raw.match(/badge\/License-([A-Za-z0-9_.-]+)-blue/i) || raw.match(/License:\s*([A-Za-z0-9_.-]+)/i);
    const detectedLicense = licMatch ? licMatch[1].replace(/--/g, '-').replace(/__/g, '_') : null;
    badges.push({
      raw,
      startIndex: match.index,
      endIndex: match.index + raw.length,
      type: 'marker',
      detectedLicense
    });
  }

  // 2. Shields.io Markdown badges
  // e.g. [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
  // or   [![License](https://img.shields.io/github/license/owner/repo)](LICENSE)
  const mdShieldRegex = /\[!\[(?:License|Licence|licen[cs]e)[^\]]*\]\((?:https?:)?\/\/img\.shields\.io\/(?:badge\/[Ll]icen[cs]e-[^)\s]+|github\/license\/[^)\s]+)\)\]\([^)]*\)/g;
  while ((match = mdShieldRegex.exec(content)) !== null) {
    // Avoid re-matching badges already inside a managed marker block
    const isInsideMarker = badges.some(
      (b) => b.type === 'marker' && match.index >= b.startIndex && match.index < b.endIndex
    );
    if (!isInsideMarker) {
      const raw = match[0];
      const licMatch = raw.match(/badge\/License-([A-Za-z0-9_.-]+)-/i) || raw.match(/License:\s*([A-Za-z0-9_.-]+)/i);
      const detectedLicense = licMatch ? licMatch[1].replace(/--/g, '-').replace(/__/g, '_') : null;
      badges.push({
        raw,
        startIndex: match.index,
        endIndex: match.index + raw.length,
        type: 'shield_md',
        detectedLicense
      });
    }
  }

  // 3. HTML <a><img ...></a> or <img ...> license badges
  const htmlShieldRegex = /(?:<a\b[^>]*>\s*)?<img\b[^>]*src=["'](?:https?:)?\/\/img\.shields\.io\/(?:badge\/[Ll]icen[cs]e|github\/license)[^"']*["'][^>]*>(?:\s*<\/a>)?/gi;
  while ((match = htmlShieldRegex.exec(content)) !== null) {
    const isInsideMarker = badges.some(
      (b) => match.index >= b.startIndex && match.index < b.endIndex
    );
    if (!isInsideMarker) {
      const raw = match[0];
      const licMatch = raw.match(/badge\/License-([A-Za-z0-9_.-]+)-/i);
      const detectedLicense = licMatch ? licMatch[1].replace(/--/g, '-').replace(/__/g, '_') : null;
      badges.push({
        raw,
        startIndex: match.index,
        endIndex: match.index + raw.length,
        type: 'shield_html',
        detectedLicense
      });
    }
  }

  return badges.sort((a, b) => a.startIndex - b.startIndex);
}

/**
 * Detect the presence and boundaries of a badge group in README markdown.
 *
 * @param {string} content
 * @returns {{ exists: boolean, startIndex: number, endIndex: number, lineIndex: number, hasOtherBadges: boolean }}
 */
export function detectBadgeGroup(content) {
  if (!content || typeof content !== 'string') {
    return { exists: false, startIndex: -1, endIndex: -1, lineIndex: -1, hasOtherBadges: false };
  }

  const lines = content.split(/\r?\n/);
  let firstBadgeLine = -1;
  let lastBadgeLine = -1;
  let hasOtherBadges = false;

  const badgeLinePattern = /(?:\[!\[[^\]]*\]\([^)]+\)\]|<img\b[^>]*src=["'][^"']*shields\.io|<a\b[^>]*>\s*<img\b)/i;
  const nonLicenseBadgePattern = /(?:img\.shields\.io\/(?!badge\/[Ll]icen[cs]e|github\/license)|badge\/(?!License-))/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (badgeLinePattern.test(line)) {
      if (firstBadgeLine === -1) firstBadgeLine = i;
      lastBadgeLine = i;
      if (nonLicenseBadgePattern.test(line)) {
        hasOtherBadges = true;
      }
    } else if (firstBadgeLine !== -1 && lastBadgeLine === i - 1) {
      // Allow 1 blank line between badge lines
      if (line !== '') {
        break;
      }
    }
  }

  if (firstBadgeLine === -1) {
    return { exists: false, startIndex: -1, endIndex: -1, lineIndex: -1, hasOtherBadges: false };
  }

  // Calculate character indices
  let currentIndex = 0;
  let startIndex = -1;
  let endIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length + (i < lines.length - 1 ? 1 : 0);
    if (i === firstBadgeLine) startIndex = currentIndex;
    if (i === lastBadgeLine) endIndex = currentIndex + lines[i].length;
    currentIndex += lineLen;
  }

  return {
    exists: true,
    startIndex,
    endIndex,
    lineIndex: firstBadgeLine,
    hasOtherBadges
  };
}

/**
 * Detect existing license sections in README markdown.
 *
 * @param {string} content
 * @returns {Array<{ heading: string, headingText: string, level: number, startIndex: number, endIndex: number, content: string, body: string, isAttribution: boolean, isManagedBlock: boolean, detectedLicense: string|null }>}
 */
export function detectLicenseSections(content) {
  if (!content || typeof content !== 'string') return [];
  const sections = [];

  const headingRegex = /^(\#{1,6})\s+(.+)$/gm;
  const headingMatches = [];
  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    headingMatches.push({
      index: match.index,
      level: match[1].length,
      heading: match[0],
      headingText: match[2].trim(),
      length: match[0].length
    });
  }

  const isLicenseHeading = (text) => {
    const clean = text.toLowerCase().replace(/[`*_[\]]/g, '').trim();
    return (
      clean === 'license' ||
      clean === 'licence' ||
      clean === 'licensing' ||
      clean.startsWith('license ') ||
      clean.startsWith('licensing ') ||
      clean.startsWith('licence ') ||
      /^licen[cs]e\s+(?:&|and)\s+attribution$/i.test(clean) ||
      /^licen[cs]e\s+(?:&|and)\s+copyright$/i.test(clean) ||
      /^copyright\s+(?:&|and)\s+licen[cs]e$/i.test(clean) ||
      /^licen[cs]e\s+notice$/i.test(clean) ||
      /^licen[cs](?:e|ing)\s+information$/i.test(clean)
    );
  };

  for (let i = 0; i < headingMatches.length; i++) {
    const h = headingMatches[i];
    if (isLicenseHeading(h.headingText)) {
      // Find the end of this section: next heading with level <= h.level, or end of file
      let nextSectionStart = content.length;
      for (let j = i + 1; j < headingMatches.length; j++) {
        if (headingMatches[j].level <= h.level) {
          nextSectionStart = headingMatches[j].index;
          break;
        }
      }

      const rawSection = content.slice(h.index, nextSectionStart);
      const body = rawSection.slice(h.length).trim();
      const isAttribution = /attribution/i.test(h.headingText) || /keep upstream notices/i.test(body);
      const isManagedBlock = /<!-- (?:open-workers|license-advisor|open-license-advisor):bottom:start -->/.test(rawSection);

      // Extract mentioned license
      let detectedLicense = null;
      if (/\b(?:Apache(?:-|\s+)2(?:\.0)?)\b/i.test(body)) detectedLicense = 'Apache-2.0';
      else if (/\bMIT\b/i.test(body)) detectedLicense = 'MIT';
      else if (/\b(?:GPL(?:-|\s*)3(?:\.0)?)\b/i.test(body)) detectedLicense = 'GPL-3.0';
      else if (/\b(?:GPL(?:-|\s*)2(?:\.0)?)\b/i.test(body)) detectedLicense = 'GPL-2.0';
      else if (/\b(?:AGPL(?:-|\s*)3(?:\.0)?)\b/i.test(body)) detectedLicense = 'AGPL-3.0';
      else if (/\b(?:BSD(?:-|\s*)3(?:-Clause)?)\b/i.test(body)) detectedLicense = 'BSD-3-Clause';
      else if (/\b(?:BSD(?:-|\s*)2(?:-Clause)?)\b/i.test(body)) detectedLicense = 'BSD-2-Clause';
      else if (/\b(?:MPL(?:-|\s*)2(?:\.0)?)\b/i.test(body)) detectedLicense = 'MPL-2.0';
      else if (/\b(?:Unlicense|public domain)\b/i.test(body)) detectedLicense = 'Unlicense';

      sections.push({
        heading: h.heading,
        headingText: h.headingText,
        level: h.level,
        startIndex: h.index,
        endIndex: nextSectionStart,
        content: rawSection,
        body,
        isAttribution,
        isManagedBlock,
        detectedLicense
      });
    }
  }

  return sections;
}

/**
 * Inspect README markdown and generate a comprehensive diagnostic report.
 *
 * @param {string} content
 * @param {string|null} [targetLicenseId=null]
 * @returns {object}
 */
export function inspectReadme(content, targetLicenseId = null) {
  if (!content || typeof content !== 'string') {
    return {
      hasReadme: false,
      hasTitle: false,
      titleText: null,
      badges: [],
      hasLicenseBadge: false,
      badgeGroup: { exists: false, hasOtherBadges: false },
      sections: [],
      hasLicenseSection: false,
      isAmbiguous: false,
      detectedLicense: null,
      conflicts: [],
      warnings: []
    };
  }

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const titleText = titleMatch ? titleMatch[1].trim() : null;

  const badges = detectLicenseBadges(content);
  const badgeGroup = detectBadgeGroup(content);
  const sections = detectLicenseSections(content);

  const isAmbiguous = sections.length > 1;
  const detectedLicense =
    sections[0]?.detectedLicense || badges[0]?.detectedLicense || null;

  const conflicts = [];
  const warnings = [];

  if (isAmbiguous) {
    warnings.push(
      `Multiple License headings (${sections.length}) detected. Review in Advanced Editor to select the appropriate section.`
    );
  }

  if (targetLicenseId) {
    const normTarget = targetLicenseId.toLowerCase();
    for (const b of badges) {
      if (b.detectedLicense && b.detectedLicense.toLowerCase() !== normTarget) {
        conflicts.push({
          type: 'badge',
          current: b.detectedLicense,
          proposed: targetLicenseId,
          detail: `Existing license badge specifies "${b.detectedLicense}", which contradicts proposed "${targetLicenseId}".`
        });
      }
    }

    for (const s of sections) {
      if (s.detectedLicense && s.detectedLicense.toLowerCase() !== normTarget) {
        conflicts.push({
          type: 'section',
          current: s.detectedLicense,
          proposed: targetLicenseId,
          detail: `Existing "${s.heading}" section specifies "${s.detectedLicense}", which contradicts proposed "${targetLicenseId}".`
        });
      }
    }
  }

  return {
    hasReadme: true,
    hasTitle: Boolean(titleMatch),
    titleText,
    badges,
    hasLicenseBadge: badges.length > 0,
    badgeGroup,
    sections,
    hasLicenseSection: sections.length > 0,
    isAmbiguous,
    detectedLicense,
    conflicts,
    warnings
  };
}

/**
 * Intelligent, conflict-aware README license updater.
 *
 * @param {string} content Original README markdown
 * @param {object} options
 * @param {object} options.license { id, name }
 * @param {string} [options.licenseLink='LICENSE']
 * @param {string} [options.badgeAction] 'update_badge' | 'insert_badge_group' | 'insert_top' | 'none'
 * @param {string} [options.sectionAction] 'update_section' | 'add_section' | 'keep_section' | 'none'
 * @param {string} [options.customReadmeContent] Advanced manual edit
 * @param {string} [options.placement] Legacy placement override ('none' | 'top' | 'bottom' | 'both')
 * @returns {string} Updated README markdown
 */
export function smartUpdateReadme(content, options = {}) {
  if (typeof options.customReadmeContent === 'string') {
    return options.customReadmeContent;
  }

  const { license, licenseLink = 'LICENSE' } = options;
  if (!license || !license.id) throw new Error('Valid license object with id is required.');

  const newline = content && content.includes('\r\n') ? '\r\n' : '\n';
  const snippets = licenseReadmeSnippets(license, licenseLink);

  // Translate legacy placement if provided and actions are not explicitly specified
  let badgeAction = options.badgeAction;
  let sectionAction = options.sectionAction;

  if (options.placement) {
    if (!README_PLACEMENTS.includes(options.placement)) {
      throw new Error('Invalid README placement.');
    }
    if (options.placement === 'none') return content;
    if (!badgeAction) {
      badgeAction =
        options.placement === 'top' || options.placement === 'both' ? 'update_badge' : 'none';
    }
    if (!sectionAction) {
      sectionAction =
        options.placement === 'bottom' || options.placement === 'both' ? 'update_section' : 'none';
    }
  }

  // Set default recommended actions if not specified
  const inspection = inspectReadme(content, license.id);
  if (!badgeAction) {
    badgeAction = inspection.hasLicenseBadge
      ? 'update_badge'
      : inspection.badgeGroup.exists
      ? 'insert_badge_group'
      : 'insert_top';
  }
  if (!sectionAction) {
    sectionAction = inspection.hasLicenseSection ? 'update_section' : 'add_section';
  }

  let result = content || '';

  // 1. Clean existing managed marker blocks
  result = result.replace(
    /<!-- (?:open-workers|license-advisor|open-license-advisor):(top|bottom):start -->[\s\S]*?<!-- (?:open-workers|license-advisor|open-license-advisor):\1:end -->(?:\r?\n){0,2}/g,
    ''
  );

  const block = (pos) =>
    `<!-- open-workers:${pos}:start -->\n${snippets[pos]}\n<!-- open-workers:${pos}:end -->`.replace(
      /\n/g,
      newline
    );

  // 2. Handle Badge Action
  if (badgeAction === 'update_badge') {
    const currentBadges = detectLicenseBadges(result);
    if (currentBadges.length > 0) {
      // Replace the first license badge in place with canonical snippet
      const firstBadge = currentBadges[0];
      const before = result.slice(0, firstBadge.startIndex);
      const after = result.slice(firstBadge.endIndex);
      result = before + snippets.top + after;

      // Remove any subsequent duplicate license badges
      const remainingBadges = detectLicenseBadges(result);
      for (let i = remainingBadges.length - 1; i >= 1; i--) {
        const b = remainingBadges[i];
        result = result.slice(0, b.startIndex) + result.slice(b.endIndex);
      }
    } else {
      // If no license badge exists, insert into badge group or below title
      badgeAction = inspection.badgeGroup.exists ? 'insert_badge_group' : 'insert_top';
    }
  }

  if (badgeAction === 'insert_badge_group') {
    const group = detectBadgeGroup(result);
    if (group.exists) {
      // Insert on the last badge line or immediately below the badge group
      const before = result.slice(0, group.endIndex);
      const after = result.slice(group.endIndex);
      result = before + newline + snippets.top + after;
    } else {
      badgeAction = 'insert_top';
    }
  }

  if (badgeAction === 'insert_top') {
    const frontMatter = result.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/)?.[0] || '';
    const prefix = frontMatter || (result.startsWith('\uFEFF') ? '\uFEFF' : '');
    const bodyAfterFrontMatter = result.slice(prefix.length);

    result =
      prefix +
      (prefix && !prefix.endsWith('\n') && prefix !== '\uFEFF' ? newline : '') +
      block('top') +
      newline +
      newline +
      bodyAfterFrontMatter;
  }

  // 3. Handle License Section Action
  if (sectionAction === 'update_section') {
    const currentSections = detectLicenseSections(result);
    // Find the primary license section to update
    // If a section is pure license (not custom attribution), update it
    const targetSection = currentSections.find((s) => !s.isAttribution) || currentSections[0];

    if (targetSection) {
      // Preserve heading level and exact text: e.g. "## License"
      const heading = targetSection.heading;
      const updatedSection = `${heading}${newline}${newline}${
        license.id === 'Unlicense' ? 'Released into the public domain under' : 'Licensed under'
      } [${license.name}](${licenseLink}).${newline}`;

      const before = result.slice(0, targetSection.startIndex);
      const after = result.slice(targetSection.endIndex);
      result = before + updatedSection + (after.startsWith(newline) ? after.slice(newline.length) : after);
    } else {
      sectionAction = 'add_section';
    }
  }

  if (sectionAction === 'add_section') {
    const currentSections = detectLicenseSections(result);
    if (currentSections.length === 0) {
      result +=
        (result && !result.endsWith(newline + newline)
          ? result.endsWith(newline)
            ? newline
            : newline + newline
          : '') +
        block('bottom') +
        newline;
    }
  }

  return result;
}

/**
 * Backward-compatible entrypoint for existing tests and callers.
 *
 * @param {string} content
 * @param {object} license
 * @param {string} placement 'none' | 'top' | 'bottom' | 'both'
 * @param {string} [licenseLink='LICENSE']
 * @returns {string}
 */
export function updateReadmeLicense(content, license, placement, licenseLink = 'LICENSE') {
  if (!README_PLACEMENTS.includes(placement)) throw new Error('Invalid README placement.');
  if (placement === 'none') return content;

  // Check if content has custom attribution text (e.g. ## License & Attribution)
  const sections = detectLicenseSections(content);
  const hasAttribution = sections.some((s) => s.isAttribution);

  return smartUpdateReadme(content, {
    license,
    licenseLink,
    placement,
    // Preserve custom attribution sections for backward compatibility
    sectionAction: hasAttribution ? 'keep_section' : undefined
  });
}

/**
 * Generate a standard unified diff between two text documents.
 *
 * @param {string} original
 * @param {string} proposed
 * @param {string} [filename='README.md']
 * @returns {string}
 */
export function generateUnifiedDiff(original, proposed, filename = 'README.md') {
  const origLines = (original || '').split(/\r?\n/);
  const propLines = (proposed || '').split(/\r?\n/);

  if (original === proposed) {
    return `--- a/${filename}\n+++ b/${filename}\n@@ No changes @@\n`;
  }

  // Simple, robust line diff
  const diffLines = [];
  diffLines.push(`--- a/${filename}`);
  diffLines.push(`+++ b/${filename}`);

  let i = 0;
  let j = 0;

  while (i < origLines.length || j < propLines.length) {
    if (i < origLines.length && j < propLines.length && origLines[i] === propLines[j]) {
      diffLines.push(` ${origLines[i]}`);
      i++;
      j++;
    } else {
      // Lookahead match
      let matchFound = false;
      for (let lookahead = 1; lookahead <= 3; lookahead++) {
        if (i + lookahead < origLines.length && origLines[i + lookahead] === propLines[j]) {
          for (let k = 0; k < lookahead; k++) {
            diffLines.push(`-${origLines[i++]}`);
          }
          matchFound = true;
          break;
        }
        if (j + lookahead < propLines.length && origLines[i] === propLines[j + lookahead]) {
          for (let k = 0; k < lookahead; k++) {
            diffLines.push(`+${propLines[j++]}`);
          }
          matchFound = true;
          break;
        }
      }

      if (!matchFound) {
        if (i < origLines.length) diffLines.push(`-${origLines[i++]}`);
        if (j < propLines.length) diffLines.push(`+${propLines[j++]}`);
      }
    }
  }

  return diffLines.join('\n');
}

/**
 * Safe, accessible Markdown-to-HTML renderer with strict XSS sanitization.
 * Strips script tags, style tags, iframes, and event handlers.
 *
 * @param {string} markdown
 * @returns {string} Sanitized HTML string
 */
export function renderSafeMarkdown(markdown) {
  if (!markdown || typeof markdown !== 'string') return '';

  // 1. Pre-sanitize raw dangerous HTML elements
  let safe = markdown
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    .replace(/\bon\w+\s*=\s*(?:["'][^"']*["']|[^\s>]+)/gi, ''); // remove event handlers

  const escapeHtml = (str) =>
    str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  // Process code blocks first to protect code contents
  const codeBlocks = [];
  safe = safe.replace(/```([a-z0-9_-]*)\r?\n([\s\S]*?)```/gi, (_m, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<pre><code class="language-${escapeHtml(lang || 'text')}">${escapeHtml(code)}</code></pre>`
    );
    return `__CODE_BLOCK_${idx}__`;
  });

  // Process inline code
  const inlineCodes = [];
  safe = safe.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `__INLINE_CODE_${idx}__`;
  });

  const lines = safe.split(/\r?\n/);
  const htmlLines = [];
  let inList = false;

  const isSafeUrl = (url) => {
    const trimmed = (url || '').trim().toLowerCase();
    if (trimmed.startsWith('javascript:') || trimmed.startsWith('vbscript:') || trimmed.startsWith('data:')) {
      return false;
    }
    return true;
  };

  for (let line of lines) {
    const trimmed = line.trim();

    if (/^#{1,6}\s+/.test(trimmed)) {
      if (inList) {
        htmlLines.push('</ul>');
        inList = false;
      }
      const level = trimmed.match(/^#+/)[0].length;
      const text = trimmed.slice(level).trim();
      htmlLines.push(`<h${level}>${escapeHtml(text)}</h${level}>`);
      continue;
    }

    if (/^---$/.test(trimmed)) {
      if (inList) {
        htmlLines.push('</ul>');
        inList = false;
      }
      htmlLines.push('<hr>');
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) {
        htmlLines.push('<ul>');
        inList = true;
      }
      const itemText = trimmed.replace(/^[-*]\s+/, '');
      htmlLines.push(`<li>${escapeHtml(itemText)}</li>`);
      continue;
    }

    if (inList) {
      htmlLines.push('</ul>');
      inList = false;
    }

    if (trimmed === '') {
      continue;
    }

    if (/^__CODE_BLOCK_\d+__$/.test(trimmed)) {
      htmlLines.push(trimmed);
      continue;
    }

    // Process markdown links and images in paragraph line
    let p = escapeHtml(trimmed);

    // Images: ![alt](url)
    p = p.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
      if (!isSafeUrl(url)) return escapeHtml(alt);
      return `<img src="${encodeURI(url)}" alt="${escapeHtml(alt)}" style="max-height: 24px; vertical-align: middle; margin: 2px;">`;
    });

    // Links: [text](url)
    p = p.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => {
      if (!isSafeUrl(url)) return escapeHtml(text);
      return `<a href="${encodeURI(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });

    // Bold & italic
    p = p.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    p = p.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    htmlLines.push(`<p>${p}</p>`);
  }

  if (inList) {
    htmlLines.push('</ul>');
  }

  let finalHtml = htmlLines.join('\n');

  // Restore inline codes
  finalHtml = finalHtml.replace(/__INLINE_CODE_(\d+)__/g, (_m, idx) => inlineCodes[Number(idx)] || '');

  // Restore code blocks
  finalHtml = finalHtml.replace(/__CODE_BLOCK_(\d+)__/g, (_m, idx) => codeBlocks[Number(idx)] || '');

  return finalHtml;
}
