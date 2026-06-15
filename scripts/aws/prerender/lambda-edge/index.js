// Lambda@Edge для prerender-разделов CloudFront distribution kingside.site.
// Событие: origin-response.
//
// Логика:
//   - status 200/2xx → пропускаем как есть
//   - status 403 и 404 → подменяем тело на /index.html из бакета kingside-frontend,
//                        статус 200, Content-Type text/html, Cache-Control 60s.
//                        В этом контексте оба кода означают «объекта нет в S3»:
//                          * 404 — бакет грантит s3:ListBucket OAC-принципалу;
//                          * 403 — не грантит (текущая конфигурация — без ListBucket).
//                        Lambda привязана ИСКЛЮЧИТЕЛЬНО к prerender-правилам
//                        (/broadcasts/* /tournaments/* /arena/* /lectures/* /coach/*
//                        /player/* /archive/games/* /archive/players/*); 403 от ALB
//                        в /api/* сюда не попадает — у тех правил Lambda не подключена.
//   - 5xx → пропускаем как есть (не маскируем инфраструктурные сбои)
//
// ADR-128 §7.3.4, KS-4191.
//
// Runtime: nodejs20.x (AWS SDK v3 встроен).
// Регион функции: us-east-1 (требование Lambda@Edge).

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

// S3-бакет фронта живёт в eu-central-1 — SDK ходит туда напрямую с edge-региона.
const FRONTEND_BUCKET = 'kingside-frontend-342946498289';
const FRONTEND_KEY = 'index.html';
const FRONTEND_REGION = 'eu-central-1';

const s3 = new S3Client({ region: FRONTEND_REGION });

// Минимальный кэш в памяти Lambda-инстанса: index.html меняется при каждом
// фронтенд-деплое (раз в день в среднем). 5 минут — баланс между свежестью и
// нагрузкой на S3. Edge-инстансы переиспользуются между запросами в рамках одной
// тёплой сессии.
let cachedBody = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchIndexHtml() {
    const now = Date.now();
    if (cachedBody && (now - cachedAt) < CACHE_TTL_MS) {
        return cachedBody;
    }
    const obj = await s3.send(new GetObjectCommand({
        Bucket: FRONTEND_BUCKET,
        Key: FRONTEND_KEY
    }));
    const body = await obj.Body.transformToString('utf-8');
    cachedBody = body;
    cachedAt = now;
    return body;
}

exports.handler = async (event) => {
    const response = event.Records[0].cf.response;
    const status = parseInt(response.status, 10);

    if (status !== 403 && status !== 404) {
        return response;
    }

    let body;
    try {
        body = await fetchIndexHtml();
    } catch (err) {
        console.error('[prerender-fallback] failed to fetch index.html', {
            bucket: FRONTEND_BUCKET,
            key: FRONTEND_KEY,
            err: err && err.message
        });
        // На сбой инфры — отдаём оригинальный ответ от S3.
        return response;
    }

    // ВАЖНО: модифицируем response по месту, точечно. В origin-response часть
    // заголовков read-only (X-Amz-Cf-*, X-Cache, X-Edge-*, Connection,
    // Transfer-Encoding и т.д.). Замена `response.headers = {...}` стирает их и
    // CloudFront возвращает 502 «tried to add, delete, or change a read-only
    // header». Перезаписываем только те поля, которые нужно сменить.
    response.status = '200';
    response.statusDescription = 'OK';
    if (!response.headers) {
        response.headers = {};
    }
    response.headers['content-type'] = [
        { key: 'Content-Type', value: 'text/html; charset=utf-8' }
    ];
    response.headers['cache-control'] = [
        { key: 'Cache-Control', value: 'public, max-age=60' }
    ];
    // ETag и Last-Modified от S3-ошибки не релевантны новому телу — но удалять
    // их нельзя (read-only check срабатывает на любое изменение в map). Браузер
    // примет HTML по content-type, инвалидные ETag/Last-Modified не нарушают
    // отрисовку, кэш фронта обнулится через 60 с.
    response.body = body;
    response.bodyEncoding = 'text';
    return response;
};
