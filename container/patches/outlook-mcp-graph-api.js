/**
 * Microsoft Graph API helper — patched version.
 *
 * Upstream outlook-mcp@2.4.2 never sets the `ConsistencyLevel: eventual`
 * request header. Microsoft Graph requires this header for any "advanced
 * query" — which includes `$search` with KQL field syntax like
 * `subject:"..."` or `from:"..."`. Without it, Graph returns:
 *   400 Bad Request — Syntax error: character ':' is not valid at position N
 * This causes every field-scoped search in search.js to fail and fall
 * through to an unfiltered "recent emails" query.
 *
 * Graph accepts this header on any request and ignores it for non-advanced
 * queries, so setting it unconditionally is safe and future-proof.
 */
const https = require('https');
const config = require('../config');
const mockData = require('./mock-data');

async function callGraphAPI(accessToken, method, path, data = null, queryParams = {}) {
  if (config.USE_TEST_MODE && accessToken.startsWith('test_access_token_')) {
    console.error(`TEST MODE: Simulating ${method} ${path} API call`);
    return mockData.simulateGraphAPIResponse(method, path, data, queryParams);
  }

  try {
    console.error(`Making real API call: ${method} ${path}`);

    const encodedPath = path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    let queryString = '';
    if (Object.keys(queryParams).length > 0) {
      const filter = queryParams.$filter;
      if (filter) {
        delete queryParams.$filter;
      }

      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(queryParams)) {
        params.append(key, value);
      }

      queryString = params.toString();

      if (filter) {
        if (queryString) {
          queryString += `&$filter=${encodeURIComponent(filter)}`;
        } else {
          queryString = `$filter=${encodeURIComponent(filter)}`;
        }
      }

      if (queryString) {
        queryString = '?' + queryString;
      }

      console.error(`Query string: ${queryString}`);
    }

    const url = `${config.GRAPH_API_ENDPOINT}${encodedPath}${queryString}`;
    console.error(`Full URL: ${url}`);

    return new Promise((resolve, reject) => {
      const options = {
        method: method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          // Required for advanced queries ($search with KQL field syntax,
          // $count on folders, $orderby on non-indexed fields). Harmless
          // for simple queries — Graph just ignores it when not needed.
          ConsistencyLevel: 'eventual',
        },
      };

      const req = https.request(url, options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              responseData = responseData ? responseData : '{}';
              const jsonResponse = JSON.parse(responseData);
              resolve(jsonResponse);
            } catch (error) {
              reject(new Error(`Error parsing API response: ${error.message}`));
            }
          } else if (res.statusCode === 401) {
            reject(new Error('UNAUTHORIZED'));
          } else {
            reject(new Error(`API call failed with status ${res.statusCode}: ${responseData}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Network error during API call: ${error.message}`));
      });

      if (data && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
        req.write(JSON.stringify(data));
      }

      req.end();
    });
  } catch (error) {
    console.error('Error calling Graph API:', error);
    throw error;
  }
}

module.exports = {
  callGraphAPI,
};
