const mammoth = require('mammoth');

/**
 * Extract plain text from a .docx file
 * @param {string} filePath - Path to .docx file
 * @returns {Promise<string>} Extracted text
 */
async function extractText(filePath) {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  } catch (err) {
    throw new Error(`Failed to read ${filePath}: ${err.message}`);
  }
}

module.exports = { extractText };