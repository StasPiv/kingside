#!/usr/bin/env node
/*
 * KS-3717 / KS-3701. Замена `aws s3 cp` из docker-entrypoint.sh на
 * Node-скрипт через `@aws-sdk/client-s3`. Это убирает зависимость от
 * apt-пакета `awscli` в образе api (он тянул ~80 МБ python+boto).
 *
 * Использование:
 *   node download-model.mjs --bucket <name> --key <s3-key> --out <path>
 *                           [--region <aws-region>] [--quiet]
 *
 * Поведение:
 *   - Успех: exit 0, файл записан атомарно через временный <out>.part.
 *   - Ошибка (NoSuchKey, AccessDenied, network) — exit 1; сообщение
 *     в stderr. Частично записанный файл удаляется.
 *   - --quiet подавляет stderr-сообщения об ошибках (для опциональных
 *     загрузок: corner_detector v<X>/model.onnx может отсутствовать
 *     в S3 — entrypoint раньше игнорировал это через `2>/dev/null`).
 *
 * Креды: подбираются стандартным default-провайдером AWS SDK
 *   - переменные окружения AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY,
 *   - IRSA через AWS_WEB_IDENTITY_TOKEN_FILE (EKS),
 *   - IAM role задачи через AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
 *     или AWS_CONTAINER_CREDENTIALS_FULL_URI (ECS Fargate).
 *
 * Регион: приоритет — флаг --region, затем AWS_REGION / AWS_DEFAULT_REGION.
 * Если не задан ни через флаг, ни через env, SDK падает с ошибкой
 * `Region is missing` — этот кейс мы перехватываем и пишем понятный
 * текст в stderr.
 */

import { createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

function parseArgs(argv) {
  const args = { quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bucket') args.bucket = argv[++i];
    else if (a === '--key') args.key = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--region') args.region = argv[++i];
    else if (a === '--quiet') args.quiet = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function usage() {
  return (
    'Usage: download-model.mjs --bucket <name> --key <s3-key> --out <path>\n' +
    '                          [--region <aws-region>] [--quiet]\n'
  );
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`download-model: ${e.message}\n${usage()}`);
    process.exit(2);
  }

  if (args.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  for (const k of ['bucket', 'key', 'out']) {
    if (!args[k]) {
      process.stderr.write(`download-model: --${k} is required\n${usage()}`);
      process.exit(2);
    }
  }

  const region =
    args.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!region) {
    if (!args.quiet) {
      process.stderr.write(
        'download-model: region is missing (pass --region or set AWS_REGION)\n',
      );
    }
    process.exit(1);
  }

  const client = new S3Client({ region });
  const tmp = `${args.out}.part`;

  try {
    const resp = await client.send(
      new GetObjectCommand({ Bucket: args.bucket, Key: args.key }),
    );
    if (!resp.Body) {
      throw new Error('S3 response has empty Body');
    }
    // resp.Body is a Node Readable in Node runtime (SDK v3 lazy-resolves
    // to ReadableStream in browsers). pipeline handles both via stream
    // interop in Node 20.
    await pipeline(resp.Body, createWriteStream(tmp));
    await rename(tmp, args.out);
    process.exit(0);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    if (!args.quiet) {
      const name = e && e.name ? `${e.name}: ` : '';
      const msg = e && e.message ? e.message : String(e);
      process.stderr.write(
        `download-model: s3://${args.bucket}/${args.key} → ${args.out} failed: ${name}${msg}\n`,
      );
    }
    process.exit(1);
  } finally {
    client.destroy();
  }
}

main();
