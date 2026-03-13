const path = require('node:path');
const fs = require('node:fs/promises');
const mammoth = require('mammoth');

async function loadFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.txt' || ext === '.md') {
    return fs.readFile(filePath, 'utf8');
  }

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  throw new Error(`Unsupported file type: ${ext}`);
}

module.exports = {
  loadFile
};
