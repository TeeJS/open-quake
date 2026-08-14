'use strict';

const path = require('path');

const IMAGE_MIME = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
});

function officeShortcutImageDataUrl(value, fs, maxBytes = 512 * 1024) {
  if (typeof value !== 'string' || !value || !fs) return null;
  const mime = IMAGE_MIME[path.extname(value).slice(1).toLowerCase()];
  if (!mime) return null;
  try {
    const stat = fs.statSync(value);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return 'data:' + mime + ';base64,' + fs.readFileSync(value).toString('base64');
  } catch (e) { return null; }
}

module.exports = { IMAGE_MIME, officeShortcutImageDataUrl };
