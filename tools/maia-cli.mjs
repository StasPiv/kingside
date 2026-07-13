#!/usr/bin/env node
/**
 * Самодостаточный CLI над packages/maia-core для ai-review в контейнере.
 * Заменяет устаревший ks3617-run-maia.mjs (тот ссылался на apps/web/, куда
 * данные maia больше не кладутся — переехали в packages/maia-core, ADR-124).
 *
 *   node maia-cli.mjs --fen "<FEN>" [--elo 1500] [--top 5]
 *
 * Выводит JSON: {"fen","elo","winProbability","moves":[{move,probability}]}.
 *
 * Сборка в самодостаточный бандл (external: onnxruntime-web) — см.
 * Dockerfile.agent. Модель берётся из MAIA_MODEL (env) или ./model.onnx
 * рядом со скриптом.
 */
import { resolve } from 'node:path';
import { Maia, createNodeProvider, loadModelFromFs } from '@kingside/maia-core';

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

async function main() {
  const fen = opt('fen', null);
  const elo = parseInt(opt('elo', '1500'), 10);
  const top = parseInt(opt('top', '5'), 10);
  if (!fen) {
    console.error('Использование: maia-cli --fen "<FEN>" [--elo 1500] [--top 5]');
    process.exit(2);
  }
  // __dirname доступен в cjs-бандле esbuild; модель лежит рядом со скриптом.
  const modelPath = process.env.MAIA_MODEL || resolve(__dirname, 'model.onnx');
  const maia = new Maia({
    provider: createNodeProvider(),
    fetchBuffer: () => loadModelFromFs(modelPath),
  });
  const { policy, winProbability } = await maia.predictMoves(fen, elo, elo);
  // Формат вывода drop-in совместим с прежним ks3617-run-maia.mjs:
  // {fen, elo, winProbability, top:[{move, probability}]}.
  const topMoves = policy.slice(0, top).map((p) => ({
    move: p.move,
    probability: Math.round(p.probability * 10000) / 10000,
  }));
  console.log(JSON.stringify({ fen, elo, winProbability, top: topMoves }, null, 2));
}

main().catch((e) => {
  console.error('maia-cli error:', e.message);
  process.exit(1);
});
