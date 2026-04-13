/**
 * List emails functionality — patched version.
 *
 * Upstream outlook-mcp@2.4.2 list.js has its own inline folder resolver that
 * filters by `displayName eq '${folder}'`. For well-known aliases like "sent"
 * or "sentitems" the filter matches nothing (the real displayName is
 * "Sent Items" with a space), so the endpoint silently falls back to the
 * inbox. This patch routes list-emails through the same resolveFolderPath
 * helper that search.js already uses.
 */
const config = require('../config');
const { callGraphAPI } = require('../utils/graph-api');
const { ensureAuthenticated, createAuthRequiredResponse } = require('../auth');
const { resolveFolderPath } = require('./folder-utils');

async function handleListEmails(args) {
  const folder = args.folder || 'inbox';
  const count = Math.min(args.count || 10, config.MAX_RESULT_COUNT);

  try {
    const accessToken = await ensureAuthenticated();
    if (!accessToken) {
      return await createAuthRequiredResponse('list-emails');
    }

    const endpoint = await resolveFolderPath(accessToken, folder);
    console.error(`list-emails using endpoint: ${endpoint} for folder: ${folder}`);

    // Sent Items uses sentDateTime; everything else uses receivedDateTime.
    const isSent = /sentitems/i.test(endpoint);
    const orderBy = isSent ? 'sentDateTime desc' : 'receivedDateTime desc';

    const queryParams = {
      $top: count,
      $orderby: orderBy,
      $select: `${config.EMAIL_SELECT_FIELDS},sentDateTime`,
    };

    const response = await callGraphAPI(accessToken, 'GET', endpoint, null, queryParams);

    if (!response.value || response.value.length === 0) {
      return {
        content: [{ type: 'text', text: `No emails found in ${folder}.` }],
      };
    }

    const emailList = response.value
      .map((email, index) => {
        const sender = email.from
          ? email.from.emailAddress
          : { name: 'Unknown', address: 'unknown' };
        const dateRaw = isSent ? email.sentDateTime : email.receivedDateTime;
        const date = dateRaw ? new Date(dateRaw).toLocaleString() : '(no date)';
        const readStatus = email.isRead ? '' : '[UNREAD] ';
        const toRecipients = isSent && email.toRecipients
          ? email.toRecipients
              .map((r) => r.emailAddress?.address)
              .filter(Boolean)
              .join(', ')
          : null;
        const header = isSent && toRecipients
          ? `${index + 1}. ${date} - To: ${toRecipients}`
          : `${index + 1}. ${readStatus}${date} - From: ${sender.name} (${sender.address})`;
        return `${header}\nSubject: ${email.subject}\nID: ${email.id}\n`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `Found ${response.value.length} emails in ${folder}:\n\n${emailList}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error listing emails: ${error.message}` }],
    };
  }
}

module.exports = handleListEmails;
