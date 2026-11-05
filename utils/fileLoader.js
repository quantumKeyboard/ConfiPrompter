const path = require('node:path');
const fs = require('node:fs/promises');
const mammoth = require('mammoth');

const SUPPORTED_EXTENSIONS = ['txt', 'md', 'markdown', 'docx'];
const MAX_FILE_BYTES = 20 * 1024 * 1024;

async function loadFile(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');

  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported file type: .${ext || '?'} (use ${SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(', ')})`);
  }

  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error('That is not a file.');
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error('File is too large (limit 20 MB).');
  }

  if (ext === 'docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  const text = await fs.readFile(filePath, 'utf8');
  // Strip a UTF-8 BOM so it doesn't render as a stray character.
  return text.replace(/^﻿/, '');
}

module.exports = {
  loadFile,
  SUPPORTED_EXTENSIONS
};
