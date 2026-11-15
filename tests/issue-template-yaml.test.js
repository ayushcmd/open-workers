import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { generateDocument, listTemplates } from '../src/modules/community/engine.js';

describe('Issue Template YAML Front Matter Escaping & Parsing (Fixes #15)', () => {
  const issueTemplateIds = [
    'issue-bug-report',
    'issue-feature-request',
    'issue-documentation'
  ];

  function extractFrontMatter(content) {
    assert.ok(content.startsWith('---\n'), 'Content must begin with YAML front matter delimiter');
    const parts = content.split('---\n');
    assert.ok(parts.length >= 3, 'Content must contain opening and closing YAML delimiters');
    return parts[1];
  }

  it('generates valid YAML front matter for all three templates with defaults', () => {
    for (const templateId of issueTemplateIds) {
      const doc = generateDocument({ templateId });
      const rawYaml = extractFrontMatter(doc.content);
      const parsed = YAML.parse(rawYaml);

      assert.strictEqual(typeof parsed, 'object');
      assert.strictEqual(typeof parsed.name, 'string');
      assert.strictEqual(typeof parsed.about, 'string');
      assert.strictEqual(typeof parsed.title, 'string');
      assert.strictEqual(typeof parsed.labels, 'string');
      assert.strictEqual(parsed.assignees, '');
    }
  });

  const testDescriptions = [
    { label: 'colon followed by space', value: 'Crash: upload failed' },
    { label: 'hash/comment character', value: 'Report #123' },
    { label: 'boolean string true', value: 'true' },
    { label: 'boolean string false', value: 'false' },
    { label: 'embedded single quote / apostrophe', value: "it's broken" },
    { label: 'multiple quotes and colons', value: "User's file: didn't load #456" }
  ];

  for (const { label, value } of testDescriptions) {
    it(`correctly round-trips '${value}' (${label}) as a string in all issue templates`, () => {
      for (const templateId of issueTemplateIds) {
        const doc = generateDocument({
          templateId,
          options: { about: value }
        });

        const rawYaml = extractFrontMatter(doc.content);

        // Ensure YAML does not throw ScannerError / syntax error
        let parsed;
        assert.doesNotThrow(() => {
          parsed = YAML.parse(rawYaml);
        }, `Failed to parse YAML for ${templateId} with about="${value}"`);

        // Validate type is strictly string (not boolean, number, or object)
        assert.strictEqual(
          typeof parsed.about,
          'string',
          `Parsed 'about' for ${templateId} must be a string, got ${typeof parsed.about}`
        );

        // Validate exact value equality without comment truncation or escaping corruption
        assert.strictEqual(
          parsed.about,
          value,
          `Parsed 'about' for ${templateId} must equal the original input string`
        );
      }
    });
  }

  it('ensures issueTitle and labels also escape quotes and round-trip cleanly', () => {
    const doc = generateDocument({
      templateId: 'issue-bug-report',
      options: {
        about: "Can't connect: timeout #99",
        issueTitle: "[BUG] User's issue: failed",
        labels: "bug, user's-report"
      }
    });

    const parsed = YAML.parse(extractFrontMatter(doc.content));
    assert.strictEqual(parsed.about, "Can't connect: timeout #99");
    assert.strictEqual(parsed.title, "[BUG] User's issue: failed");
    assert.strictEqual(parsed.labels, "bug, user's-report");
  });

  it('confirms PR template and other community documents remain unchanged and without front matter', () => {
    const prDoc = generateDocument({
      templateId: 'pull-request-template',
      options: { summary: 'New feature', testing: 'Tests pass' }
    });
    assert.strictEqual(prDoc.content.startsWith('---'), false, 'PR template must not have front matter');
    assert.ok(prDoc.content.includes('## Summary'));

    const contributing = generateDocument({
      templateId: 'contributing',
      options: { projectName: 'MyProject' }
    });
    assert.strictEqual(contributing.content.startsWith('---'), false);
    assert.ok(contributing.content.includes('# Contributing to MyProject'));

    const codeOfConduct = generateDocument({
      templateId: 'code-of-conduct',
      options: { communityName: 'MyCommunity', enforcementContact: 'team@example.com' }
    });
    assert.strictEqual(codeOfConduct.content.startsWith('---'), false);

    const security = generateDocument({
      templateId: 'security',
      options: { projectName: 'MyProject', supportedVersions: '1.x', reportingContact: 'sec@example.com' }
    });
    assert.strictEqual(security.content.startsWith('---'), false);

    const support = generateDocument({
      templateId: 'support',
      options: { projectName: 'MyProject' }
    });
    assert.strictEqual(support.content.startsWith('---'), false);
  });
});
