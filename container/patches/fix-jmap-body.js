/**
 * Patch @jahfer/jmap-mcp-server getEmailContent to correctly read email bodies.
 *
 * Bug: textBody/htmlBody are arrays of EmailBodyPart objects, not strings.
 * Fix: request bodyValues with fetchTextBodyValues/fetchHTMLBodyValues,
 *      then look up actual content by partId.
 */
const fs = require('fs');
const file = process.argv[2];
let src = fs.readFileSync(file, 'utf8');

// 1. Add bodyValues to properties and enable fetch flags
src = src.replace(
  'properties: ["id", "textBody", "htmlBody", "subject", "from", "to", "cc", "bcc", "sentAt", "receivedAt", "bodyStructure"]',
  'properties: ["id", "textBody", "htmlBody", "subject", "from", "to", "cc", "bcc", "sentAt", "receivedAt", "bodyStructure", "bodyValues"], fetchTextBodyValues: true, fetchHTMLBodyValues: true'
);

// 2. Replace the body content extraction block
const oldBlock = `    let bodyContent = "No body content found.";
    if (email.textBody) {
      bodyContent = email.textBody;
    } else if (email.htmlBody) {
      bodyContent = email.htmlBody;
    } else if (email.bodyStructure && email.bodyStructure.partId) {
      // It may be necessary to fetch body parts separately
      const downloadUrl = session.downloadUrl
        .replace("{accountId}", accountId)
        .replace("{blobId}", email.bodyStructure.partId)
        .replace("{type}", email.bodyStructure.type)
        .replace("{name}", email.bodyStructure.name || "download");

      try {
        const response = await fetch(downloadUrl, {
          headers: {
            "Authorization": \`Bearer \${JMAP_TOKEN}\`
          }
        });
        if (response.ok) {
          bodyContent = await response.text();
        } else {
          bodyContent = \`Failed to download body content: \${response.statusText}\`;
        }
      } catch (e) {
        bodyContent = \`Error downloading body content: \${e.message}\`;
      }
    }`;

const newBlock = `    let bodyContent = "No body content found.";
    const bv = email.bodyValues || {};
    if (email.textBody && email.textBody.length > 0) {
      bodyContent = email.textBody.map(p => (bv[p.partId] || {}).value || "").join("\\n");
    } else if (email.htmlBody && email.htmlBody.length > 0) {
      bodyContent = email.htmlBody.map(p => (bv[p.partId] || {}).value || "").join("\\n");
    }`;

if (!src.includes(oldBlock)) {
  console.error('WARNING: Could not find body extraction block to patch');
  process.exit(1);
}

src = src.replace(oldBlock, newBlock);

fs.writeFileSync(file, src);
console.log('Patched getEmailContent in', file);
