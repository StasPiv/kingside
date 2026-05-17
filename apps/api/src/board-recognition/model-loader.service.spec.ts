import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  BOARD_RECOG_MODEL_DIR_ENV,
  BOARD_RECOG_MODEL_PATH_ENV,
  BOARD_RECOG_MODEL_VERSION_ENV,
  ModelLoaderService,
} from './model-loader.service';

describe('ModelLoaderService (KS-2363)', () => {
  let tmpRoot: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    delete process.env[BOARD_RECOG_MODEL_VERSION_ENV];
    delete process.env[BOARD_RECOG_MODEL_PATH_ENV];
    delete process.env[BOARD_RECOG_MODEL_DIR_ENV];
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'model-loader-'));
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns disabled when no env vars are set', async () => {
    const svc = new ModelLoaderService();
    await svc.onModuleInit();
    expect(svc.getState()).toEqual({
      status: 'disabled',
      version: null,
      modelPath: null,
      error: null,
    });
  });

  it('returns loaded when version + model file exist', async () => {
    const modelPath = path.join(tmpRoot, 'model.onnx');
    await fs.writeFile(modelPath, Buffer.from('not really onnx but non-empty'));
    process.env[BOARD_RECOG_MODEL_VERSION_ENV] = '1.0.0';
    process.env[BOARD_RECOG_MODEL_DIR_ENV] = tmpRoot;

    const svc = new ModelLoaderService();
    await svc.onModuleInit();

    expect(svc.getState()).toEqual({
      status: 'loaded',
      version: '1.0.0',
      modelPath,
      error: null,
    });
  });

  it('returns error when version set but file missing', async () => {
    process.env[BOARD_RECOG_MODEL_VERSION_ENV] = '1.0.0';
    process.env[BOARD_RECOG_MODEL_DIR_ENV] = tmpRoot;

    const svc = new ModelLoaderService();
    await svc.onModuleInit();
    const state = svc.getState();
    expect(state.status).toBe('error');
    expect(state.version).toBe('1.0.0');
    expect(state.error).toMatch(/model file not found/);
  });

  it('returns error when model file is empty (corrupted download)', async () => {
    const modelPath = path.join(tmpRoot, 'model.onnx');
    await fs.writeFile(modelPath, Buffer.alloc(0));
    process.env[BOARD_RECOG_MODEL_VERSION_ENV] = '1.0.0';
    process.env[BOARD_RECOG_MODEL_DIR_ENV] = tmpRoot;

    const svc = new ModelLoaderService();
    await svc.onModuleInit();
    const state = svc.getState();
    expect(state.status).toBe('error');
    expect(state.error).toMatch(/empty/);
  });

  it('honors BOARD_RECOG_MODEL_PATH override without version', async () => {
    const modelPath = path.join(tmpRoot, 'custom-model.onnx');
    await fs.writeFile(modelPath, Buffer.from('x'));
    process.env[BOARD_RECOG_MODEL_PATH_ENV] = modelPath;

    const svc = new ModelLoaderService();
    await svc.onModuleInit();
    const state = svc.getState();
    expect(state.status).toBe('loaded');
    expect(state.modelPath).toBe(modelPath);
    expect(state.version).toBeNull();
  });

  it('refresh() re-reads state on demand', async () => {
    const svc = new ModelLoaderService();
    await svc.onModuleInit();
    expect(svc.getState().status).toBe('disabled');

    const modelPath = path.join(tmpRoot, 'model.onnx');
    await fs.writeFile(modelPath, Buffer.from('x'));
    process.env[BOARD_RECOG_MODEL_VERSION_ENV] = '2.0.0';
    process.env[BOARD_RECOG_MODEL_DIR_ENV] = tmpRoot;

    const state = await svc.refresh();
    expect(state.status).toBe('loaded');
    expect(state.version).toBe('2.0.0');
  });
});
