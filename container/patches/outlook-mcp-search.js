/**
 * Search emails functionality — patched version.
 *
 * Upstream outlook-mcp@2.4.2 search.js combines `$search` with
 * `$orderby: receivedDateTime desc` in every query. Microsoft Graph returns
 * HTTP 400 for that combination (unsupported). The progressive search then
 * falls through every strategy until the final bare "recent emails" query
 * succeeds — which returns whatever the endpoint defaults to.
 *
 * This patch:
 *   1. Omits $orderby when $search is set (Graph requirement).
 *   2. Uses sentDateTime for ordering when the folder is Sent Items.
 *   3. Picks the right date field in the formatted output too.
 */
const config = require('../config');
const { callGraphAPI } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');
const { resolveFolderPath } = require('./folder-utils');

async function handleSearchEmails(args) {
  const folder = args.folder || 'inbox';
  const count = Math.min(args.count || 10, config.MAX_RESULT_COUNT);
  const query = args.query || '';
  const from = args.from || '';
  const to = args.to || '';
  const subject = args.subject || '';
  const hasAttachments = args.hasAttachments;
  const unreadOnly = args.unreadOnly;

  try {
    const accessToken = await ensureAuthenticated();
    const endpoint = await resolveFolderPath(accessToken, folder);
    const isSent = /sentitems/i.test(endpoint);
    console.error(`search using endpoint: ${endpoint} for folder: ${folder} (isSent=${isSent})`);

    const response = await progressiveSearch(
      endpoint,
      accessToken,
      { query, from, to, subject },
      { hasAttachments, unreadOnly },
      count,
      isSent,
    );

    return formatSearchResults(response, isSent);
  } catch (error) {
    if (error.message === 'Authentication required') {
      return {
        content: [
          {
            type: 'text',
            text: "Authentication required. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }
    return {
      content: [{ type: 'text', text: `Error searching emails: ${error.message}` }],
    };
  }
}

async function progressiveSearch(
  endpoint,
  accessToken,
  searchTerms,
  filterTerms,
  count,
  isSent,
) {
  const searchAttempts = [];

  // 1. Combined search
  try {
    const params = buildSearchParams(searchTerms, filterTerms, count, isSent);
    searchAttempts.push('combined-search');
    const response = await callGraphAPI(accessToken, 'GET', endpoint, null, params);
    if (response.value && response.value.length > 0) {
      return response;
    }
  } catch (error) {
    console.error(`Combined search failed: ${error.message}`);
  }

  // 2. Each term individually
  const searchPriority = ['subject', 'from', 'to', 'query'];
  for (const term of searchPriority) {
    if (searchTerms[term]) {
      try {
        searchAttempts.push(`single-term-${term}`);
        // When $search is set, do NOT set $orderby — Graph returns 400.
        const simplifiedParams = {
          $top: count,
          $select: `${config.EMAIL_SELECT_FIELDS},sentDateTime`,
        };
        // Graph $search wraps the entire expression in outer quotes,
        // not the individual value. Field-scoped KQL is `field:value`
        // inside those outer quotes. Inner quotes around the value
        // produce a 400 "Syntax error: character ':' is not valid".
        if (term === 'query') {
          simplifiedParams.$search = `"${searchTerms[term]}"`;
        } else {
          simplifiedParams.$search = `"${term}:${searchTerms[term]}"`;
        }
        addBooleanFilters(simplifiedParams, filterTerms);
        const response = await callGraphAPI(accessToken, 'GET', endpoint, null, simplifiedParams);
        if (response.value && response.value.length > 0) {
          return response;
        }
      } catch (error) {
        console.error(`Search with ${term} failed: ${error.message}`);
      }
    }
  }

  // 3. Boolean filters only (safe to use $orderby here — no $search)
  if (filterTerms.hasAttachments === true || filterTerms.unreadOnly === true) {
    try {
      searchAttempts.push('boolean-filters-only');
      const filterOnlyParams = {
        $top: count,
        $select: `${config.EMAIL_SELECT_FIELDS},sentDateTime`,
        $orderby: isSent ? 'sentDateTime desc' : 'receivedDateTime desc',
      };
      addBooleanFilters(filterOnlyParams, filterTerms);
      const response = await callGraphAPI(accessToken, 'GET', endpoint, null, filterOnlyParams);
      return response;
    } catch (error) {
      console.error(`Boolean filter search failed: ${error.message}`);
    }
  }

  // 4. Final fallback: bare listing (safe to use $orderby — no $search)
  searchAttempts.push('recent-emails');
  const basicParams = {
    $top: count,
    $select: `${config.EMAIL_SELECT_FIELDS},sentDateTime`,
    $orderby: isSent ? 'sentDateTime desc' : 'receivedDateTime desc',
  };
  const response = await callGraphAPI(accessToken, 'GET', endpoint, null, basicParams);
  response._searchInfo = {
    attemptsCount: searchAttempts.length,
    strategies: searchAttempts,
    originalTerms: searchTerms,
    filterTerms: filterTerms,
  };
  return response;
}

function buildSearchParams(searchTerms, filterTerms, count, isSent) {
  const params = {
    $top: count,
    $select: `${config.EMAIL_SELECT_FIELDS},sentDateTime`,
  };

  const kqlTerms = [];
  if (searchTerms.query) kqlTerms.push(searchTerms.query);
  if (searchTerms.subject) kqlTerms.push(`subject:${searchTerms.subject}`);
  if (searchTerms.from) kqlTerms.push(`from:${searchTerms.from}`);
  if (searchTerms.to) kqlTerms.push(`to:${searchTerms.to}`);

  if (kqlTerms.length > 0) {
    // Graph API: $search cannot be combined with $orderby. The entire
    // search expression must be wrapped in outer double quotes — inner
    // quotes around field values produce a 400.
    params.$search = `"${kqlTerms.join(' ')}"`;
  } else {
    // No search terms → safe to order.
    params.$orderby = isSent ? 'sentDateTime desc' : 'receivedDateTime desc';
  }

  addBooleanFilters(params, filterTerms);
  return params;
}

function addBooleanFilters(params, filterTerms) {
  const filterConditions = [];
  if (filterTerms.hasAttachments === true) {
    filterConditions.push('hasAttachments eq true');
  }
  if (filterTerms.unreadOnly === true) {
    filterConditions.push('isRead eq false');
  }
  if (filterConditions.length > 0) {
    params.$filter = filterConditions.join(' and ');
  }
}

function formatSearchResults(response, isSent) {
  if (!response.value || response.value.length === 0) {
    return {
      content: [{ type: 'text', text: `No emails found matching your search criteria.` }],
    };
  }

  const emailList = response.value
    .map((email, index) => {
      const sender = email.from?.emailAddress || { name: 'Unknown', address: 'unknown' };
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

  let additionalInfo = '';
  if (response._searchInfo) {
    additionalInfo = `\n(Search used ${response._searchInfo.strategies[response._searchInfo.strategies.length - 1]} strategy)`;
  }

  return {
    content: [
      {
        type: 'text',
        text: `Found ${response.value.length} emails matching your search criteria:${additionalInfo}\n\n${emailList}`,
      },
    ],
  };
}

module.exports = handleSearchEmails;
