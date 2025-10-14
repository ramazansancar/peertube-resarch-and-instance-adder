const axios = require('axios');
const axiosRetry = require('axios-retry').default || require('axios-retry');
const fs = require('fs').promises;
const path = require('path');

const config = {
  concurrent: 90, // Concurrent requests
  baseURL: 'https://instances.joinpeertube.org/api/v1/instances',
  headers: {
    'accept': '*/*',
    'accept-language': 'tr,en-US;q=0.9,en;q=0.8,tr-TR;q=0.7,zh-CN;q=0.6,zh-TW;q=0.5,zh;q=0.4,ja;q=0.3,ko;q=0.2,bg;q=0.1',
    'content-type': 'application/json',
    'origin': 'https://instances.joinpeertube.org',
    'priority': 'u=1, i',
    'referer': 'https://instances.joinpeertube.org/instances/add',
    'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  }
};

let instances = [];

//let instances = require('./list2.js')

const nowTime = (i = 1) => {
  let dates = new Date();
  let year = dates.getFullYear();
  let month = String([dates.getMonth() + 1]).padStart(2, '0');
  let day = String(dates.getDate()).padStart(2, '0');
  let hour = String(dates.getHours()).padStart(2, '0');
  let minute = String(dates.getMinutes()).padStart(2, '0');
  let second = String(dates.getSeconds()).padStart(2, '0');
  let millisecond = String(dates.getMilliseconds()).padStart(3, '0');
  if (i == 1) return day + `/` + month + `/` + year + ` ` + hour + `:` + minute + `:` + second + `.` + millisecond
  else if (i == 2) return day + `/` + month
  else if (i == 3) return year + `_` + month + `_` + day;
  else return day + "-" + month + "-" + year + "_" + hour + "-" + minute + "-" + second
};

// Configure axios-retry
axiosRetry(axios, {
  retries: 5, // Maximum 5 retry attempts
  retryDelay: axiosRetry.exponentialDelay, // Exponential backoff delay
  retryCondition: (error) => {
    // Retry on network errors or 5xx server errors
    return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
      error.response?.status >= 500 ||
      error.code === 'ECONNRESET' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNABORTED' ||
      !error.response; // Network error (NETWORK_ERROR case)
  },
  onRetry: (retryCount, error, requestConfig) => {
    console.log(`Retry attempt ${retryCount} for ${requestConfig.data ? JSON.parse(requestConfig.data).host : 'unknown host'}: ${error.message}`);
  }
});

// Curl Request Bash Map

// curl 'https://instances.joinpeertube.org/api/v1/instances' \
//   -H 'accept: */*' \
//   -H 'accept-language: tr,en-US;q=0.9,en;q=0.8,tr-TR;q=0.7,zh-CN;q=0.6,zh-TW;q=0.5,zh;q=0.4,ja;q=0.3,ko;q=0.2,bg;q=0.1' \
//   -H 'content-type: application/json' \
//   -H 'origin: https://instances.joinpeertube.org' \
//   -H 'priority: u=1, i' \
//   -H 'referer: https://instances.joinpeertube.org/instances/add' \
//   -H 'sec-ch-ua: "Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"' \
//   -H 'sec-ch-ua-mobile: ?0' \
//   -H 'sec-ch-ua-platform: "Windows"' \
//   -H 'sec-fetch-dest: empty' \
//   -H 'sec-fetch-mode: cors' \
//   -H 'sec-fetch-site: same-origin' \
//   -H 'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' \
//   --data-raw '{"host":"asd.com"}'

// Add instance
async function addInstance(host) {
  try {
    const response = await axios.post(config.baseURL,
      { host: host },
      {
        headers: config.headers,
        timeout: 30000, // 30 seconds timeout (increased for better retry chances)
        'axios-retry': {
          retries: 5,
          retryCondition: (error) => {
            // Custom retry logic for this specific request
            if (error.response?.status === 429) {
              console.log(`Rate limit hit for ${host}, retrying...`);
              return true;
            }
            if (error.response?.status >= 409) {
              // 409 Conflict - Instance already exists or similar client error, do not retry
              return false;
            }
            return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
              error.response?.status >= 500 ||
              !error.response || // Network error case (NETWORK_ERROR)
              error.code === 'ECONNRESET' ||
              error.code === 'ETIMEDOUT' ||
              error.code === 'ENOTFOUND' ||
              error.code === 'ECONNABORTED';
          }
        }
      }
    );

    console.log(`✓ Successfully added: ${host} (HTTP ${response.status})`);

    return {
      host: host,
      success: true,
      status: response.status,
      data: response.data
    };
  } catch (error) {
    const errorInfo = {
      host: host,
      success: false,
      status: error.response?.status || 'NETWORK_ERROR',
      error: error.response?.data || error.message,
      code: error.code,
      retryCount: error.config?.['axios-retry']?.retryCount || 0
    };
    if (errorInfo.retryCount > 0) {
      console.log(`✗ Failed to add: ${host} (${errorInfo.status}) - Retries: ${errorInfo.retryCount}`);
    }
    return errorInfo;
  }
}

// Parallel processing manager
async function processInBatches(items, batchSize, processor) {
  const results = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    console.log(`Processing: ${i + 1}-${Math.min(i + batchSize, items.length)} / ${items.length}`);

    const batchResults = await Promise.all(
      batch.map(processor)
    );

    results.push(...batchResults);

    // Short delay between batches
    if (i + batchSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return results;
}

// Write results to file
function writeResultsToFile(results) {
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  const report = [];
  report.push(`PeerTube Instance Adding Report`);
  report.push(`=================================`);
  report.push(`Date: ${new Date().toLocaleString('tr-TR')}`);
  report.push(`Total Processed: ${results.length}`);
  report.push(`Successful: ${successful.length}`);
  report.push(`Failed: ${failed.length}`);
  report.push(``);

  if (successful.length > 0) {
    report.push(`SUCCESSFUL INSTANCES:`);
    report.push(`--------------------`);
    successful.forEach(result => {
      const instanceInfo = result.data?.instance;
      const instanceUrl = `https://instances.joinpeertube.org/instances?search=${result.host}`;
      if (instanceInfo) {
        report.push(`✓ ${result.host} - ID: ${instanceInfo.id} - HTTP ${result.status} - ${instanceUrl}`);
      } else {
        report.push(`✓ ${result.host} - HTTP ${result.status} - ${instanceUrl}`);
      }
    });
    report.push(``);
  }

  if (failed.length > 0) {
    report.push(`FAILED INSTANCES:`);
    report.push(`------------------`);
    failed.forEach(result => {
      const errorMsg = typeof result.error === 'object'
        ? JSON.stringify(result.error)
        : result.error;
      const retryInfo = result.retryCount > 0 ? ` (${result.retryCount} retries)` : '';
      report.push(`✗ ${result.host} - HTTP ${result.status} - ${errorMsg}${retryInfo}`);
    });
  }

  const fileName = `peertube-results-${Date.now()}.txt`;
  const filePath = path.join(__dirname, fileName);

  fs.writeFileSync(filePath, report.join('\n'), 'utf8');
  console.log(`\nRapor dosyası oluşturuldu: ${fileName}`);
  report.forEach(line => console.log(line));

  return filePath;
  return true;
}

async function readNewInstancesFile() {
  try {
    const filePath = path.join(__dirname, 'new-instances.txt');
    const content = await fs.readFile(filePath, 'utf-8');
    return content
      .split('\n')
      .map(line => line.replace(/[",]/g, '').trim())
      .filter(line => line.length > 0);
  } catch (error) {
    console.log(`[${nowTime(1)}] new-instances.txt not found, creating new file`);
    return [];
  }
}

// Main processing function
async function main() {
  instances = await readNewInstancesFile();

  console.log(`PeerTube Instance Adding Process Started...`);
  console.log(`Total ${instances.length} instances will be processed`);
  console.log(`Concurrent requests: ${config.concurrent}\n`);

  const startTime = Date.now();

  try {
    const results = await processInBatches(instances, config.concurrent, addInstance);

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    console.log(`\nProcess completed! Duration: ${duration.toFixed(2)} seconds`);

    // Write results to file
    writeResultsToFile(results);

    // Summary information
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`\nSUMMARY:`);
    console.log(`Successful: ${successful}`);
    console.log(`Failed: ${failed}`);
    console.log(`Total: ${results.length}`);

  } catch (error) {
    console.error('Main processing error:', error);
  }
}

// Run main if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

