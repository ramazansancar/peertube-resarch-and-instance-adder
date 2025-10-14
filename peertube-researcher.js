const axios = require('axios');
const axiosRetry = require('axios-retry').default || require('axios-retry');
const redis = require('redis');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');

// Time utility function
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

// Configuration
const config = {
  redis: {
    enabled: process.argv.includes('--use-redis'), // Redis kullanımı için --use-redis argümanı gerekli
    host: '192.168.1.200',
    port: 6379,
    database: 1, // 0-15 arası Redis database number (redis node cluster | default: 0)
    expireDuration: 3 * (60 * 60) + 30, // Redis key expiry time in seconds (3 hours + 30 seconds)
    maxCacheKeysPerEndpoint: 5, // Her endpoint için tutulacak maksimum cache key sayısı
  },
  concurrent: 60, // Eşzamanlı istek limiti
  timeout: 30000,
  pagination: {
    count: 100, // Max 100
    startFrom: 0,
  },
  retryConfig: {
    maxRetries: 5,
    retryDelay: 5000,
  },
  axios: {
    maxRedirects: 10,
  },
  testMode: false, // Test için az sayıda instance kullan
  testInstanceCount: 5, // Test modunda kaç instance kullanılacak
};

// Instances array - tüm PeerTube instances
let instances = [];

// Default axios instance
const axiosInstance = axios.create({
  timeout: config.timeout,
  headers: {
    'User-Agent': 'PeerTube-Gallery/1.0',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  },
  redirect: 'follow',
  maxRedirects: config.axios.maxRedirects,
  // SSL hatalarını bypass et
  httpsAgent: new https.Agent({
    rejectUnauthorized: false,
    secureProtocol: 'TLSv1_2_method',
    ciphers: 'ALL:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA',
  }),
  httpAgent: new http.Agent({
    keepAlive: true,
    timeout: config.timeout,
  }),
});

// Configure axios-retry for the main axios instance
axiosRetry(axiosInstance, {
  retries: config.retryConfig.maxRetries, // Maximum retry attempts
  retryDelay: (retryCount, error) => {
    // Exponential backoff with jitter
    const delay = Math.min(1000 * Math.pow(2, retryCount), config.retryConfig.retryDelay);
    const jitter = Math.random() * 1000; // Add up to 1 second of jitter
    return delay + jitter;
  },
  retryCondition: (error) => {
    // Retry on network errors or 5xx server errors
    return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
      error.response?.status >= 500 ||
      error.code === 'ECONNRESET' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNABORTED' ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'EPROTO' ||
      error.code === 'CERT_HAS_EXPIRED' ||
      error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      error.code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
      error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      error.message?.includes('certificate') ||
      error.message?.includes('SSL') ||
      error.message?.includes('TLS') ||
      !error.response; // Network error (NETWORK_ERROR case)
  },
  onRetry: (retryCount, error, requestConfig) => {
    const instanceUrl = requestConfig.url ? new URL(requestConfig.url).host : 'unknown';
    console.log(`[${nowTime(1)}] Retry attempt ${retryCount}/${config.retryConfig.maxRetries} for ${instanceUrl}: ${error.message}`);
  }
});

// Request interceptor - instanceUrl'e göre origin ve referer ayarla
axiosInstance.interceptors.request.use(
  (config) => {
    // instanceUrl varsa origin ve referer header'larını ayarla
    if (config.url) {
      try {
        const url = new URL(config.url);
        const origin = `${url.protocol}//${url.host}`;
        config.headers['Referer'] = `${origin}/`;
        config.headers['Origin'] = origin;
        config.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36 - (Peertube Researcher)';
      } catch {
        console.warn('Failed to parse URL for headers:', config.url);
      }
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor - retry bilgilerini dahil eder
// Aynı hatayı birden fazla kez loglamaktan kaçınmak için cache
const errorLogCache = new Map();

axiosInstance.interceptors.response.use(
  (response) => {
    // Başarılı response'larda retry sayısını logla (eğer retry yapıldıysa)
    const retryCount = response.config?.['axios-retry']?.retryCount || 0;
    if (retryCount > 0) {
      const instanceUrl = response.config.url ? new URL(response.config.url).host : 'unknown';
      console.log(`[${nowTime(1)}] Success after ${retryCount} retries for ${instanceUrl}`);
    }
    return response;
  },
  (error) => {
    const retryCount = error.config?.['axios-retry']?.retryCount || 0;
    const instanceUrl = error.config?.url ? new URL(error.config.url).host : 'unknown';
    
    // Aynı instance ve hata kombinasyonu için sadece bir kez log yaz
    const errorKey = `${instanceUrl}-${error.code || error.message}`;
    const now = Date.now();
    const lastLogged = errorLogCache.get(errorKey);
    
    // 30 saniye içinde aynı hatayı tekrar loglamamaya karar ver
    if (!lastLogged || (now - lastLogged) > 30000) {
      if (retryCount > 0) {
        console.error(`[${nowTime(1)}] Final failure after ${retryCount} retries for ${instanceUrl}: ${error.message}`);
      } else {
        console.error(`[${nowTime(1)}] Request failed for ${instanceUrl}: ${error.message}`);
      }
      errorLogCache.set(errorKey, now);
    }
    
    return Promise.reject(error);
  }
);

// Redis client setup
let redisClient;

async function initRedis() {
  if (!config.redis.enabled) {
    console.log(`[${nowTime(1)}] Redis disabled - running without cache`);
    return;
  }

  redisClient = redis.createClient({
    socket: {
      host: config.redis.host,
      port: config.redis.port,
    },
    database: config.redis.database,
  });

  redisClient.on('error', (err) => console.error(`[${nowTime(1)}] Redis Client Error:`, err));
  redisClient.on('connect', () => console.log(`[${nowTime(1)}] Connected to Redis`));

  await redisClient.connect();
}

// File operations
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

async function appendToNewInstancesFile(newHosts) {
  if (newHosts.length === 0) return;

  const filePath = path.join(__dirname, 'new-instances.txt');
  const existingHosts = await readNewInstancesFile();

  const uniqueNewHosts = newHosts.filter(host => !existingHosts.includes(host));

  if (uniqueNewHosts.length > 0) {
    const content = uniqueNewHosts.map(host => `"${host}",`).join('\n') + '\n';
    await fs.appendFile(filePath, content, 'utf-8');
    console.log(`[${nowTime(1)}] Added ${uniqueNewHosts.length} new instances to file:`, uniqueNewHosts);
  }
}

// Redis operations
async function getLastProcessedState(instanceUrl, endpoint = 'video-channels') {
  if (!config.redis.enabled || !redisClient) {
    return { start: 0, count: config.pagination.count };
  }

  try {
    const pattern = `peertube:${instanceUrl}:${endpoint}:*`;
    const keys = await redisClient.keys(pattern);

    if (keys.length === 0) {
      return { start: 0, count: config.pagination.count };
    }

    // En son kaydedilen state'i bul
    const states = [];
    for (const key of keys) {
      const match = key.match(new RegExp(`peertube:(.+):${endpoint}:(\\d+)-(\\d+)`));
      if (match) {
        states.push({
          key,
          start: parseInt(match[2]),
          count: parseInt(match[3])
        });
      }
    }

    if (states.length === 0) {
      return { start: 0, count: config.pagination.count };
    }

    // En yüksek start değerini bul
    states.sort((a, b) => b.start - a.start);
    const lastState = states[0];

    return {
      start: lastState.start + lastState.count,
      count: config.pagination.count
    };
  } catch (error) {
    console.error(`[${nowTime(1)}] Error getting last state for ${instanceUrl}/${endpoint}:`, error.message);
    return { start: 0, count: config.pagination.count };
  }
}

async function saveProcessedState(instanceUrl, endpoint, start, count, data) {
  if (!config.redis.enabled || !redisClient) {
    return;
  }

  try {
    const key = `peertube:${instanceUrl}:${endpoint}:${start}-${count}`;
    await redisClient.setEx(key, config.redis.expireDuration, JSON.stringify({
      timestamp: new Date().toISOString(),
      start,
      count,
      totalFound: data.total,
      dataLength: data.data.length,
      processedAt: Date.now()
    }));

    // Sadece çok eski kayıtları temizle (config'den değer oku)
    const pattern = `peertube:${instanceUrl}:${endpoint}:*`;
    const keys = await redisClient.keys(pattern);

    if (keys.length > config.redis.maxCacheKeysPerEndpoint) {
      // Start değerine göre sırala ve en eskilerini sil
      const keyStates = [];
      for (const k of keys) {
        const match = k.match(new RegExp(`peertube:(.+):${endpoint}:(\\d+)-(\\d+)`));
        if (match) {
          keyStates.push({
            key: k,
            start: parseInt(match[2])
          });
        }
      }

      keyStates.sort((a, b) => a.start - b.start);
      const keysToDelete = keyStates.slice(0, keyStates.length - config.redis.maxCacheKeysPerEndpoint).map(k => k.key);

      if (keysToDelete.length > 0) {
        await redisClient.del(keysToDelete);
        console.log(`[${nowTime(1)}] Cleaned ${keysToDelete.length} old cache entries for ${instanceUrl}/${endpoint}`);
      }
    }
  } catch (error) {
    console.error(`[${nowTime(1)}] Error saving state for ${instanceUrl}/${endpoint}:`, error.message);
  }
}

// Fetch instances from joinpeertube.org API
async function fetchJoinPeerTubeInstances() {
  const url = 'https://instances.joinpeertube.org/api/v1/instances/hosts?start=0&count=9000&sort=-createdAt';

  try {
    console.log(`[${nowTime(1)}] Fetching instances from joinpeertube.org API`);
    const response = await axiosInstance.get(url);

    if (response.data && response.data.data && Array.isArray(response.data.data)) {
      const hosts = response.data.data.map(item => item.host).filter(host => host);
      console.log(`[${nowTime(1)}] Found ${hosts.length} instances from joinpeertube.org (total: ${response.data.total})`);
      return hosts;
    }

    return [];
  } catch (error) {
    const retryCount = error.config?.['axios-retry']?.retryCount || 0;
    if (error.code === 'EPROTO' || error.message?.includes('SSL') || error.message?.includes('certificate')) {
      console.error(`[${nowTime(1)}] SSL/Certificate error fetching instances from joinpeertube.org after ${retryCount} retries:`, error.message);
    } else {
      console.error(`[${nowTime(1)}] Error fetching instances from joinpeertube.org after ${retryCount} retries:`, error.message);
    }
    return [];
  }
}

// Update instances list with new instances from joinpeertube.org
async function updateInstancesList() {
  try {
    console.log(`[${nowTime(1)}] Updating instances list...`);
    console.log(`[${nowTime(1)}] Current instances count: ${instances.length}`);

    const joinPeerTubeHosts = await fetchJoinPeerTubeInstances();

    if (joinPeerTubeHosts.length === 0) {
      console.log(`[${nowTime(1)}] No new instances found from joinpeertube.org`);
      return;
    }

    // Duplicate kontrol - sadece yeni olanları ekle
    const existingHosts = new Set(instances);
    const newHosts = joinPeerTubeHosts.filter(host => !existingHosts.has(host));

    if (newHosts.length > 0) {
      // Yeni instance'ları tarama listesine ekle (taramaya dahil edilir)
      instances.push(...newHosts);
      console.log(`[${nowTime(1)}] Added ${newHosts.length} new instances from joinpeertube.org to scanning list`);
      console.log(`[${nowTime(1)}] Updated instances count for scanning: ${instances.length}`);

      // Yeni instance'ları dosyaya da kaydet (gelecek referans için)
      await appendToNewInstancesFile(newHosts);
      console.log(`[${nowTime(1)}] Also saved ${newHosts.length} new instances to new-instances.txt file`);
    } else {
      console.log(`[${nowTime(1)}] All instances from joinpeertube.org already exist in our list`);
    }

  } catch (error) {
    console.error(`[${nowTime(1)}] Error updating instances list:`, error.message);
  }
}

// Main processing functions
async function fetchVideoChannels(instanceUrl, start, count) {
  // searchTarget=search-index ile tüm federe instance'lardan arama yapar
  // sort=-createdAt ile en yeni kanalları önce alır
  // nsfw=both ile güvenli ve güvensiz kanalları dahil eder
  // search boş bırakıldı - tüm kanalları döndürür (maksimum sonuç için)
  const url = `https://${instanceUrl}/api/v1/search/video-channels?start=${start}&count=${count}&sort=-createdAt&searchTarget=search-index&nsfw=both&search=`;

  try {
    console.log(`[${nowTime(1)}] Fetching video-channels from ${instanceUrl} (start: ${start}, count: ${count})`);
    const response = await axiosInstance.get(url);
    return response.data;
  } catch (error) {
    const retryCount = error.config?.['axios-retry']?.retryCount || 0;

    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      console.warn(`[${nowTime(1)}] Connection failed for ${instanceUrl} after ${retryCount} retries: ${error.message}`);
    } else if (error.code === 'EPROTO' || error.message?.includes('SSL') || error.message?.includes('certificate')) {
      console.warn(`[${nowTime(1)}] SSL/Certificate error for ${instanceUrl} after ${retryCount} retries: ${error.message}`);
    } else if (error.response?.status >= 400 && error.response?.status < 500) {
      console.warn(`[${nowTime(1)}] Client error (${error.response.status}) for ${instanceUrl}: ${error.message}`);
    } else {
      console.error(`[${nowTime(1)}] Error fetching video-channels from ${instanceUrl} after ${retryCount} retries: ${error.message}`);
    }
    throw error;
  }
}

async function fetchFollowers(instanceUrl, start, count) {
  // sort=-createdAt ile en yeni follower'ları önce alır
  // actorType parametresi kaldırıldı - tüm aktör türlerini dahil eder (Person, Application, Service)
  // state parametresi kaldırıldı - tüm durumları dahil eder (pending, accepted, rejected)
  const url = `https://${instanceUrl}/api/v1/server/followers?start=${start}&count=${count}&sort=-createdAt`;

  try {
    console.log(`[${nowTime(1)}] Fetching followers from ${instanceUrl} (start: ${start}, count: ${count})`);
    const response = await axiosInstance.get(url);
    return response.data;
  } catch (error) {
    const retryCount = error.config?.['axios-retry']?.retryCount || 0;

    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      console.warn(`[${nowTime(1)}] Connection failed for ${instanceUrl} after ${retryCount} retries: ${error.message}`);
    } else if (error.code === 'EPROTO' || error.message?.includes('SSL') || error.message?.includes('certificate')) {
      console.warn(`[${nowTime(1)}] SSL/Certificate error for ${instanceUrl} after ${retryCount} retries: ${error.message}`);
    } else if (error.response?.status >= 400 && error.response?.status < 500) {
      console.warn(`[${nowTime(1)}] Client error (${error.response.status}) for ${instanceUrl}: ${error.message}`);
    } else {
      console.error(`[${nowTime(1)}] Error fetching followers from ${instanceUrl} after ${retryCount} retries: ${error.message}`);
    }
    throw error;
  }
}

async function fetchFollowing(instanceUrl, start, count) {
  // sort=-createdAt ile en yeni following'leri önce alır
  // actorType parametresi kaldırıldı - tüm aktör türlerini dahil eder (Person, Application, Service)
  // state parametresi kaldırıldı - tüm durumları dahil eder (pending, accepted, rejected)
  const url = `https://${instanceUrl}/api/v1/server/following?start=${start}&count=${count}&sort=-createdAt`;

  try {
    console.log(`[${nowTime(1)}] Fetching following from ${instanceUrl} (start: ${start}, count: ${count})`);
    const response = await axiosInstance.get(url);
    return response.data;
  } catch (error) {
    const retryCount = error.config?.['axios-retry']?.retryCount || 0;

    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      console.warn(`[${nowTime(1)}] Connection failed for ${instanceUrl} after ${retryCount} retries: ${error.message}`);
    } else if (error.code === 'EPROTO' || error.message?.includes('SSL') || error.message?.includes('certificate')) {
      console.warn(`[${nowTime(1)}] SSL/Certificate error for ${instanceUrl} after ${retryCount} retries: ${error.message}`);
    } else if (error.response?.status >= 400 && error.response?.status < 500) {
      console.warn(`[${nowTime(1)}] Client error (${error.response.status}) for ${instanceUrl}: ${error.message}`);
    } else {
      console.error(`[${nowTime(1)}] Error fetching following from ${instanceUrl} after ${retryCount} retries: ${error.message}`);
    }
    throw error;
  }
}

async function fetchVideos(instanceUrl, start, count) {
  // searchTarget=search-index ile tüm federe instance'lardan arama yapar
  // nsfw=both ile hem güvenli hem güvensiz içerikleri alır
  // nsfwFlagsIncluded=1 ile NSFW flag bilgilerini dahil eder
  // sort=-publishedAt ile en yeni yayınlanan videoları önce alır (boş arama için ideal)
  // search boş bırakıldı - tüm videoları döndürür (maksimum sonuç için)
  // isLocal parametresi kaldırıldı - hem yerel hem federe videoları dahil eder (maksimum host için)
  const url = `https://${instanceUrl}/api/v1/search/videos?start=${start}&count=${count}&sort=-publishedAt&searchTarget=search-index&nsfw=both&nsfwFlagsIncluded=1&search=`;

  try {
    console.log(`[${nowTime(1)}] Fetching videos from ${instanceUrl} (start: ${start}, count: ${count})`);
    const response = await axiosInstance.get(url);
    return response.data;
  } catch (error) {
    const retryCount = error.config?.['axios-retry']?.retryCount || 0;

    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      console.warn(`[${nowTime(1)}] Connection failed for ${instanceUrl} after ${retryCount} retries: ${error.message}`);
    } else if (error.code === 'EPROTO' || error.message?.includes('SSL') || error.message?.includes('certificate')) {
      console.warn(`[${nowTime(1)}] SSL/Certificate error for ${instanceUrl} after ${retryCount} retries: ${error.message}`);
    } else if (error.response?.status >= 400 && error.response?.status < 500) {
      console.warn(`[${nowTime(1)}] Client error (${error.response.status}) for ${instanceUrl}: ${error.message}`);
    } else {
      console.error(`[${nowTime(1)}] Error fetching videos from ${instanceUrl} after ${retryCount} retries: ${error.message}`);
    }
    throw error;
  }
}

function extractHosts(data) {
  const hosts = new Set();

  if (data.data && Array.isArray(data.data)) {
    data.data.forEach(item => {
      // Video channels için
      if (item.host) {
        hosts.add(item.host);
      }
      if (item.ownerAccount && item.ownerAccount.host) {
        hosts.add(item.ownerAccount.host);
      }

      // Followers/Following için
      if (item.follower && item.follower.host) {
        hosts.add(item.follower.host);
      }
      if (item.following && item.following.host) {
        hosts.add(item.following.host);
      }

      // Videos için - account ve channel host bilgileri
      if (item.account && item.account.host) {
        hosts.add(item.account.host);
      }
      if (item.channel && item.channel.host) {
        hosts.add(item.channel.host);
      }
    });
  }

  return Array.from(hosts);
}

async function processEndpoint(instanceUrl, endpoint, fetchFunction) {
  const allNewHosts = [];
  let start = 0;
  const count = config.pagination.count;
  let hasMoreData = true;
  let totalResults = 0;

  try {
    // Son işlenmiş durumu al
    const lastState = await getLastProcessedState(instanceUrl, endpoint);
    start = lastState.start;

    console.log(`[${nowTime(1)}] Processing ${instanceUrl}/${endpoint} from start: ${start}`);

    while (hasMoreData) {
      try {
        const data = await fetchFunction(instanceUrl, start, count);

        if (!data || !data.data) {
          console.warn(`No data returned from ${instanceUrl}/${endpoint} at start: ${start}`);
          break;
        }

        totalResults = data.total;
        const newHosts = extractHosts(data);
        allNewHosts.push(...newHosts);

        // Her sayfa sonucunu Redis'e kaydet
        await saveProcessedState(instanceUrl, endpoint, start, count, data);

        // Her sayfa sonucunu hemen dosyaya yaz
        if (newHosts.length > 0) {
          await appendToNewInstancesFile(newHosts);
          console.log(`[${nowTime(1)}] Added ${newHosts.length} new hosts from ${instanceUrl}/${endpoint} (start: ${start})`);
        }

        console.log(`[${nowTime(1)}] ${instanceUrl}/${endpoint}: Found ${newHosts.length} hosts at start ${start}/${totalResults}`);

        // Sonraki sayfaya geç
        start += count;
        hasMoreData = data.data.length === count && start < totalResults;

        // API'ye fazla yüklenmemek için kısa bir bekleme
        if (hasMoreData) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

      } catch (pageError) {
        console.error(`[${nowTime(1)}] Error processing ${instanceUrl}/${endpoint} at start ${start}:`, pageError.message);
        // Sayfa hatası durumunda devam et
        break;
      }
    }

    console.log(`[${nowTime(1)}] Completed ${instanceUrl}/${endpoint}: ${allNewHosts.length} total hosts found from ${totalResults} total results`);

    return {
      success: true,
      newHosts: allNewHosts,
      totalProcessed: start,
      total: totalResults,
      endpoint
    };

  } catch (error) {
    console.error(`[${nowTime(1)}] Failed to process ${instanceUrl}/${endpoint}:`, error.message);
    return { success: false, newHosts: allNewHosts, error: error.message, endpoint };
  }
}

async function processInstance(instanceUrl) {
  const allResults = [];
  const allNewHosts = [];

  try {
    console.log(`[${nowTime(1)}] Processing instance: ${instanceUrl}`);

    // Dört endpoint'i sırayla işle
    const endpoints = [
      { name: 'video-channels', fetchFunction: fetchVideoChannels },
      { name: 'followers', fetchFunction: fetchFollowers },
      { name: 'following', fetchFunction: fetchFollowing },
      { name: 'videos', fetchFunction: fetchVideos }
    ];

    for (const { name, fetchFunction } of endpoints) {
      try {
        const result = await processEndpoint(instanceUrl, name, fetchFunction);
        allResults.push(result);
        allNewHosts.push(...result.newHosts);
      } catch (error) {
        console.error(`[${nowTime(1)}] Error processing ${instanceUrl}/${name}:`, error.message);
        allResults.push({
          success: false,
          newHosts: [],
          error: error.message,
          endpoint: name
        });
      }
    }

    const totalHosts = [...new Set(allNewHosts)].length;
    console.log(`[${nowTime(1)}] Completed all endpoints for ${instanceUrl}: ${totalHosts} unique hosts found`);

    return {
      success: true,
      newHosts: allNewHosts,
      endpointResults: allResults,
      totalUniqueHosts: totalHosts
    };

  } catch (error) {
    console.error(`[${nowTime(1)}] Failed to process instance ${instanceUrl}:`, error.message);
    return {
      success: false,
      newHosts: allNewHosts,
      error: error.message,
      endpointResults: allResults
    };
  }
}

// Concurrent processing with semaphore
class Semaphore {
  constructor(capacity) {
    this.capacity = capacity;
    this.running = 0;
    this.queue = [];
  }

  async acquire() {
    return new Promise((resolve) => {
      if (this.running < this.capacity) {
        this.running++;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release() {
    this.running--;
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      this.running++;
      resolve();
    }
  }
}

async function processInstancesConcurrently() {
  const semaphore = new Semaphore(config.concurrent);
  const allNewHosts = [];
  let processed = 0;
  let successful = 0;
  let endpointStats = {
    'video-channels': { success: 0, failed: 0 },
    'followers': { success: 0, failed: 0 },
    'following': { success: 0, failed: 0 },
    'videos': { success: 0, failed: 0 }
  };

  // Test modunda az sayıda instance kullan
  const instancesToProcess = config.testMode ? instances.slice(0, config.testInstanceCount) : instances;

  console.log(`[${nowTime(1)}] Starting to process ${instancesToProcess.length} instances with concurrency limit: ${config.concurrent}`);
  if (config.testMode) {
    console.log(`[${nowTime(1)}] TEST MODE: Processing only first`, config.testInstanceCount, 'instances');
  }

  const processPromises = instancesToProcess.map(async (instanceUrl) => {
    await semaphore.acquire();

    try {
      const result = await processInstance(instanceUrl);
      processed++;

      if (result.success) {
        successful++;
        allNewHosts.push(...result.newHosts);

        // Endpoint istatistiklerini güncelle
        if (result.endpointResults) {
          result.endpointResults.forEach(endpointResult => {
            if (endpointResult.success) {
              endpointStats[endpointResult.endpoint].success++;
            } else {
              endpointStats[endpointResult.endpoint].failed++;
            }
          });
        }
      }

      console.log(`[${nowTime(1)}] Progress: ${processed}/${instancesToProcess.length} (${successful} successful)`);

      return result;
    } finally {
      semaphore.release();
    }
  });

  const results = await Promise.allSettled(processPromises);

  // Summary hesapla (dosyaya yazma her instance'da yapıldığı için burada yapmıyoruz)
  const uniqueHosts = [...new Set(allNewHosts)];

  console.log(`\n=== Processing Summary ===`);
  console.log(`[${nowTime(1)}] Total instances: ${instancesToProcess.length}`);
  console.log(`[${nowTime(1)}] Successful: ${successful}`);
  console.log(`[${nowTime(1)}] Failed: ${processed - successful}`);
  console.log(`[${nowTime(1)}] Total unique hosts found in this session: ${uniqueHosts.length}`);
  console.log(`[${nowTime(1)}] Endpoint Statistics:`);
  console.log(`[${nowTime(1)}]   - video-channels: ${endpointStats['video-channels'].success} success, ${endpointStats['video-channels'].failed} failed`);
  console.log(`[${nowTime(1)}]   - followers: ${endpointStats['followers'].success} success, ${endpointStats['followers'].failed} failed`);
  console.log(`[${nowTime(1)}]   - following: ${endpointStats['following'].success} success, ${endpointStats['following'].failed} failed`);
  console.log(`[${nowTime(1)}]   - videos: ${endpointStats['videos'].success} success, ${endpointStats['videos'].failed} failed`);

  return {
    totalProcessed: processed,
    successful,
    failed: processed - successful,
    newHostsCount: uniqueHosts.length,
    endpointStats,
    results
  };
}

// Main function
async function main() {
  try {
    // SSL hatalarını bypass et - global olarak
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

    console.log(`[${nowTime(1)}] PeerTube Researcher started...`);
    console.log(`[${nowTime(1)}] Configuration:`, config);
    console.log(`[${nowTime(1)}] SSL verification disabled for problematic certificates`);

    // Başlangıçta mevcut new-instances.txt dosyasını cache'e al
    const initialNewInstances = await readNewInstancesFile();
    instances = [...initialNewInstances];
    console.log(`[${nowTime(1)}] Initial new-instances.txt contains ${initialNewInstances.length} hosts`);

    await initRedis();
    if (config.redis.enabled) {
      console.log(`[${nowTime(1)}] Redis connection established`);
    }

    // Instance listesini joinpeertube.org'dan gelen verilerle güncelle
    await updateInstancesList();

    const summary = await processInstancesConcurrently();

    // Son durumda new-instances.txt dosyasını tekrar oku ve yeni eklenen host'ları hesapla
    const finalNewInstances = await readNewInstancesFile();
    const newlyAddedHosts = finalNewInstances.filter(host => !initialNewInstances.includes(host));
    const totalNewUniqueHostsFound = newlyAddedHosts.length;

    console.log(`\n=== Final Unique Hosts Summary ===`);
    console.log(`[${nowTime(1)}] Initial new-instances.txt hosts: ${initialNewInstances.length}`);
    console.log(`[${nowTime(1)}] Final new-instances.txt hosts: ${finalNewInstances.length}`);
    console.log(`[${nowTime(1)}] Total new unique hosts found: ${totalNewUniqueHostsFound}`);

    if (totalNewUniqueHostsFound > 0) {
      console.log(`[${nowTime(1)}] Sample of newly found hosts:`, newlyAddedHosts.slice(0, 10));
    }

    //console.log(`[${nowTime(1)}] \n=== Final Summary ===`);
    //console.log(JSON.stringify(summary, null, 2));

  } catch (error) {
    console.error(`[${nowTime(1)}] Main process error:`, error);
  } finally {
    if (redisClient && config.redis.enabled) {
      await redisClient.quit();
      console.log(`[${nowTime(1)}] Redis connection closed`);
    }
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log(`[${nowTime(1)}] \nReceived SIGINT, shutting down gracefully...`);
  if (redisClient && config.redis.enabled) {
    await redisClient.quit();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log(`[${nowTime(1)}] \nReceived SIGTERM, shutting down gracefully...`);
  if (redisClient && config.redis.enabled) {
    await redisClient.quit();
  }
  process.exit(0);
});

// Export for module usage
module.exports = {
  main,
  processInstance,
  processEndpoint,
  fetchVideoChannels,
  fetchFollowers,
  fetchFollowing,
  fetchVideos,
  fetchJoinPeerTubeInstances,
  updateInstancesList,
  config
};

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}
