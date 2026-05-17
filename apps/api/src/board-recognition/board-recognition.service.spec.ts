import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';

import {
  BoardRecognitionService,
  BoardRecognizer,
  RecognizeUniversalResult,
} from './board-recognition.service';
import { ModelLoaderService, ModelState } from './model-loader.service';

function makeFile(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    fieldname: 'image',
    originalname: 'board.png',
    encoding: '7bit',
    mimetype: 'image/png',
    buffer: Buffer.from('fake-png-bytes'),
    size: 14,
    stream: undefined as any,
    destination: '',
    filename: '',
    path: '',
    ...overrides,
  } as Express.Multer.File;
}

function makeLoader(state: ModelState): ModelLoaderService {
  return {
    getState: () => state,
  } as unknown as ModelLoaderService;
}

function makeRecognizer(
  fn: BoardRecognizer['recognize'] = jest.fn(),
): BoardRecognizer {
  return { recognize: fn };
}

const SUCCESS_RESULT: RecognizeUniversalResult = {
  success: true,
  usedProfile: 'generic',
  fen: '8/8/8/8/8/8/8/8 w - - 0 1',
  fen_board: '8/8/8/8/8/8/8/8',
  orientation: 'white',
  bbox: [10, 20, 200, 210],
  detect: { confidence: 0.87 },
  sanity: { valid: true, issues: [] },
  low_confidence_cells: [],
};

describe('BoardRecognitionService (KS-2363)', () => {
  describe('disabled (graceful mock)', () => {
    it('returns starting position + warning when model is disabled', async () => {
      const recognize = jest.fn();
      const svc = new BoardRecognitionService(
        makeLoader({ status: 'disabled', version: null, modelPath: null, error: null }),
        makeRecognizer(recognize),
      );

      const res = await svc.recognize(makeFile(), 'auto');

      expect(res.fenBoard).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
      expect(res.fen).toBe(
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1',
      );
      expect(res.modelVersion).toBeNull();
      expect(res.warnings[0]).toMatch(/model not loaded/);
      expect(res.lowConfidenceCells).toEqual([]);
      expect(res.orientation).toBe('white');
      expect(res.orientationConfidence).toBe(1);
      expect(recognize).not.toHaveBeenCalled();
    });
  });

  describe('error (model_load_failed)', () => {
    it('throws 500 when model status is error', async () => {
      const svc = new BoardRecognitionService(
        makeLoader({
          status: 'error',
          version: '1.0.0',
          modelPath: '/var/cache/board-recog/model.onnx',
          error: 'file missing',
        }),
        makeRecognizer(),
      );

      await expect(svc.recognize(makeFile(), 'auto')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('includes model_load_failed code in the response', async () => {
      const svc = new BoardRecognitionService(
        makeLoader({
          status: 'error',
          version: '1.0.0',
          modelPath: '/var/cache/board-recog/model.onnx',
          error: 'file missing',
        }),
        makeRecognizer(),
      );
      try {
        await svc.recognize(makeFile(), 'auto');
        fail('should have thrown');
      } catch (e) {
        const ex = e as InternalServerErrorException;
        expect(ex.getResponse()).toMatchObject({ code: 'model_load_failed' });
      }
    });
  });

  describe('input validation', () => {
    const loader = makeLoader({
      status: 'disabled',
      version: null,
      modelPath: null,
      error: null,
    });

    it('throws BadRequest when file is missing', async () => {
      const svc = new BoardRecognitionService(loader, makeRecognizer());
      await expect(svc.recognize(undefined, 'auto')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws BadRequest when file buffer is empty', async () => {
      const svc = new BoardRecognitionService(loader, makeRecognizer());
      const empty = makeFile({ buffer: Buffer.alloc(0), size: 0 });
      await expect(svc.recognize(empty, 'auto')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws BadRequest on non-image mimetype', async () => {
      const svc = new BoardRecognitionService(loader, makeRecognizer());
      const pdf = makeFile({ mimetype: 'application/pdf' });
      await expect(svc.recognize(pdf, 'auto')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('loaded (inference path)', () => {
    const loader = makeLoader({
      status: 'loaded',
      version: '1.0.0',
      modelPath: '/var/cache/board-recog/model.onnx',
      error: null,
    });

    it('forwards profile + model path to recognizer and maps the response', async () => {
      const recognize = jest.fn().mockResolvedValue({
        ...SUCCESS_RESULT,
        low_confidence_cells: [
          {
            square: 'e4',
            predicted: 'wP',
            confidence: 0.6,
            top3: [
              { label: 'wP', prob: 0.6 },
              { label: 'empty', prob: 0.3 },
              { label: 'wN', prob: 0.1 },
            ],
          },
        ],
        sanity: { valid: false, issues: ['white king count = 0 (expected 1)'] },
      });
      const svc = new BoardRecognitionService(loader, makeRecognizer(recognize));

      const res = await svc.recognize(makeFile(), 'generic');

      expect(recognize).toHaveBeenCalledTimes(1);
      const [calledPath, calledOpts] = recognize.mock.calls[0];
      expect(typeof calledPath).toBe('string');
      expect(calledOpts).toEqual({
        profile: 'generic',
        modelPath: '/var/cache/board-recog/model.onnx',
      });
      expect(res.modelVersion).toBe('1.0.0');
      expect(res.bbox).toEqual([10, 20, 200, 210]);
      expect(res.orientationConfidence).toBeCloseTo(0.87);
      expect(res.lowConfidenceCells).toHaveLength(1);
      expect(res.lowConfidenceCells[0]).toMatchObject({
        square: 'e4',
        predicted: 'wP',
      });
      expect(res.warnings).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/sanity:/),
          expect.stringMatching(/low confidence/),
        ]),
      );
    });

    it('translates detector failures into 400 board_not_detected', async () => {
      const recognize = jest
        .fn()
        .mockRejectedValue(
          new Error('board_recognize.py failed at stage=detect: no quad'),
        );
      const svc = new BoardRecognitionService(loader, makeRecognizer(recognize));

      try {
        await svc.recognize(makeFile(), 'auto');
        fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        const ex = e as BadRequestException;
        expect(ex.getResponse()).toMatchObject({ code: 'board_not_detected' });
      }
    });

    it('translates inference crashes into 500 model_load_failed', async () => {
      const recognize = jest
        .fn()
        .mockRejectedValue(new Error('onnxruntime: SegmentationFault'));
      const svc = new BoardRecognitionService(loader, makeRecognizer(recognize));

      try {
        await svc.recognize(makeFile(), 'auto');
        fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(InternalServerErrorException);
        const ex = e as InternalServerErrorException;
        expect(ex.getResponse()).toMatchObject({ code: 'model_load_failed' });
      }
    });

    it('clamps orientationConfidence into [0, 1]', async () => {
      const recognize = jest.fn().mockResolvedValue({
        ...SUCCESS_RESULT,
        detect: { confidence: 1.7 }, // out-of-band sanity
      });
      const svc = new BoardRecognitionService(loader, makeRecognizer(recognize));
      const res = await svc.recognize(makeFile(), 'auto');
      expect(res.orientationConfidence).toBe(1);
    });
  });
});
