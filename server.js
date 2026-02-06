/**
 * Manga Secure Proxy + Silent Smart Cacher v3.1
 * Updated: 2026 Optimized for Edge Persistence & Error Resilience
 */

const SECRET_KEY = "SUPER_SECRET_SAFE_KEY_123456";
const JSON_CONFIG_URL = "https://yoursite.com/manga_list.json";
const BATCH_SIZE = 5; 
const CACHE_TTL = 2592000; // 30 Days

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(p => p);

    // صفحه وضعیت ساده
    if (pathParts.length < 3) {
      return new Response("Manga Proxy Engine v3.1 | Status: Online", { 
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    const sig = url.searchParams.get("sig");
    const ts = url.searchParams.get("t");

    // ۱. تایید امضا امن
    const isValid = await verifySignature(url.pathname, ts, sig, SECRET_KEY);
    if (!isValid) {
      return new Response("Access Denied: Invalid or Expired Signature", { status: 403 });
    }

    // ۲. پردازش درخواست پروکسی
    return await handleMangaLogic(pathParts, env, ctx);
  },

  async scheduled(event, env, ctx) {
    // اجرای کش هوشمند با مدیریت Lifecycle ورکر
    ctx.waitUntil(
      runSmartCacher(env).catch(err => console.error("Critical Cache Failure: " + err.message))
    );
  }
};

/**
 * مدیریت هوشمند گرم‌کردن کش (Cacher Core)
 */
async function runSmartCacher(env) {
  const startTime = Date.now();
  
  // دریافت لیست مانگاها
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  
  const response = await fetch(JSON_CONFIG_URL, { 
    signal: controller.signal,
    headers: { 'User-Agent': 'Manga-Cacher-Bot/3.1' }
  }).catch(() => null);
  
  clearTimeout(timeoutId);

  if (!response || !response.ok) return;

  const mangaList = await response.json().catch(() => null);
  if (!Array.isArray(mangaList)) return;

  // بازیابی وضعیت آخرین پردازش از KV
  let state = { mIdx: 0, cIdx: 1, pIdx: 0 };
  const stateRaw = await env.MANGA_CACHE_STATE.get("nightly_step");
  if (stateRaw) {
    try { state = JSON.parse(stateRaw); } catch (e) { state = { mIdx: 0, cIdx: 1, pIdx: 0 }; }
  }

  for (let i = state.mIdx; i < mangaList.length; i++) {
    const manga = mangaList[i];
    
    for (let c = (i === state.mIdx ? state.cIdx : 1); c <= manga.chapters; c++) {
      let p = (i === state.mIdx && c === state.cIdx) ? state.pIdx : 0;
      let chapterFinished = false;

      while (!chapterFinished) {
        const batch = [];
        for (let b = 0; b < BATCH_SIZE; b++) {
          const pageNum = p + b;
          batch.push(warmUpPage(manga.name, c, pageNum));
        }

        const results = await Promise.all(batch);
        const failIndex = results.indexOf(false);
        
        if (failIndex !== -1) {
          p += failIndex;
          chapterFinished = true; // احتمالاً به آخرین صفحه رسیدیم
        } else {
          p += BATCH_SIZE;
        }

        // رعایت محدودیت زمانی Workers (خروج امن در ثانیه ۲۴)
        if ((Date.now() - startTime) > 24000) {
          await env.MANGA_CACHE_STATE.put("nightly_step", JSON.stringify({ mIdx: i, cIdx: c, pIdx: p }));
          return;
        }
      }
      state.pIdx = 0;
    }
    state.cIdx = 1;
  }

  // ریست کردن وضعیت پس از اتمام کامل لیست
  await env.MANGA_CACHE_STATE.put("nightly_step", JSON.stringify({ mIdx: 0, cIdx: 1, pIdx: 0 }));
}

/**
 * شبیه‌سازی درخواست برای اجبار به ذخیره در Edge
 */
async function warmUpPage(mangaName, chapter, page) {
  const base = `https://cdne.megaman-server.ir/564/${mangaName}/${chapter}`;
  const urls = [`${base}/HD/${page}.webp`, `${base}/${page}.webp`];
  
  try {
    for (const url of urls) {
      // در حالت scheduled، استفاده از fetch با cf بهترین راه برای گرم کردن کش است
      const res = await fetch(url, { 
        method: 'GET', 
        headers: { 
          'Referer': 'https://megaman-server.ir/',
          'User-Agent': 'Cloudflare-Cacher/3.1'
        },
        cf: { 
          cacheTtl: CACHE_TTL, 
          cacheEverything: true,
          cacheKey: url // تضمین یکسانی کلید کش
        } 
      });

      if (res.status === 200) {
        await res.arrayBuffer(); // مصرف کامل بادی الزامی است
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * منطق اصلی پروکسی و تحویل فایل
 */
async function handleMangaLogic(pathParts, env, ctx) {
  const [manga, chapter, file] = pathParts;
  const base = `https://cdne.megaman-server.ir/564/${manga}/${chapter}`;
  const targets = [`${base}/HD/${file}`, `${base}/${file}`];

  const cache = caches.default;

  for (const url of targets) {
    const cacheKey = new Request(url, {
        headers: { 'Referer': 'https://megaman-server.ir/' }
    });
    
    let response = await cache.match(cacheKey);
    if (response) {
        // ایجاد ریپانس جدید از روی کش برای افزودن هدرهای سفارشی
        const newHeaders = new Headers(response.headers);
        newHeaders.set('X-Proxy-Cache', 'HIT-V3');
        return new Response(response.body, { status: 200, headers: newHeaders });
    }

    const res = await fetch(url, {
      headers: { 
        'Referer': 'https://megaman-server.ir/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' 
      },
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
    });

    if (res.ok) {
      const h = new Headers(res.headers);
      h.set('Access-Control-Allow-Origin', '*');
      h.set('Cache-Control', `public, max-age=${CACHE_TTL}, immutable`);
      h.set('X-Proxy-Cache', 'MISS');

      const finalRes = new Response(res.body, { status: 200, headers: h });
      
      // ذخیره در کش به صورت غیرمسدودکننده
      ctx.waitUntil(cache.put(cacheKey, finalRes.clone()));
      
      return finalRes;
    }
  }
  return new Response("Manga Page Not Found", { status: 404 });
}

/**
 * تایید امضای دیجیتال با استاندارد Web Crypto
 */
async function verifySignature(path, timestamp, sig, secret) {
  try {
    if (!sig || !timestamp) return false;
    
    // ۱. بررسی انقضای زمان (۱ ساعت اعتبار)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp)) > 3600) return false;

    // ۲. تبدیل هگز به Uint8Array
    const sigArray = new Uint8Array(sig.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

    // ۳. پردازش HMAC
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
      "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    
    const data = encoder.encode(`${path}:${timestamp}`);
    return await crypto.subtle.verify("HMAC", key, sigArray, data);
  } catch (e) {
    return false;
  }
}
