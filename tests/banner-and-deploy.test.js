import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('README Banner & Brand Asset Integrity', () => {
  const bannerPath = path.resolve('public/assets/open-workers-banner.png');
  const readmePath = path.resolve('README.md');

  it('ensures the frosted-glass banner exists at the expected path with valid PNG headers', () => {
    assert.ok(fs.existsSync(bannerPath), 'Banner PNG must exist at public/assets/open-workers-banner.png');
    const stats = fs.statSync(bannerPath);
    assert.ok(stats.size > 50000, `Banner file size should be substantial (actual: ${stats.size} bytes)`);

    const fd = fs.openSync(bannerPath, 'r');
    const buffer = Buffer.alloc(24);
    fs.readSync(fd, buffer, 0, 24, 0);
    fs.closeSync(fd);

    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(buffer.subarray(0, 8).equals(pngSignature), 'Banner must be a valid PNG image');

    // IHDR width and height (offset 16-24)
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    assert.strictEqual(width, 1800, 'Banner width must match the approved 1800px');
    assert.strictEqual(height, 670, 'Banner height must match the approved 670px');
  });

  it('verifies README.md links to the banner image without duplicating the standalone logo', () => {
    assert.ok(fs.existsSync(readmePath), 'README.md must exist');
    const content = fs.readFileSync(readmePath, 'utf8');

    assert.ok(
      content.includes('./public/assets/open-workers-banner.png'),
      'README.md must reference ./public/assets/open-workers-banner.png'
    );
    assert.ok(
      content.includes('https://open-workers.onrender.com'),
      'README.md must link to production web app'
    );
    assert.ok(
      content.includes('https://github.com/marketplace/open-workers'),
      'README.md must link to GitHub marketplace listing'
    );
  });

  it('preserves existing official branding assets intact', () => {
    const assets = [
      'public/assets/logo.svg',
      'public/assets/favicon.svg',
      'public/assets/open-workers-logo.png',
      'public/assets/open-workers-icon.svg',
      'public/assets/open-workers-social.png',
      'public/assets/open-workers-512.png'
    ];

    for (const relPath of assets) {
      const fullPath = path.resolve(relPath);
      assert.ok(fs.existsSync(fullPath), `Asset ${relPath} must exist`);
      assert.ok(fs.statSync(fullPath).size > 0, `Asset ${relPath} must not be empty`);
    }
  });
});
