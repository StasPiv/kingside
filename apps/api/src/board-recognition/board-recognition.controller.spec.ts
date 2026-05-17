import { BadRequestException } from '@nestjs/common';

import { BoardRecognitionController } from './board-recognition.controller';
import { BoardRecognitionService } from './board-recognition.service';
import {
  BoardRecognitionProfile,
  BoardRecognitionResponse,
  RecognizeBoardDto,
} from './dto/recognize-board.dto';

function makeFile(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    fieldname: 'image',
    originalname: 'board.png',
    encoding: '7bit',
    mimetype: 'image/png',
    buffer: Buffer.from('fake-bytes'),
    size: 10,
    stream: undefined as any,
    destination: '',
    filename: '',
    path: '',
    ...overrides,
  } as Express.Multer.File;
}

const MOCK_RESPONSE: BoardRecognitionResponse = {
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1',
  fenBoard: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
  orientation: 'white',
  orientationConfidence: 1,
  bbox: [0, 0, 0, 0],
  modelVersion: null,
  lowConfidenceCells: [],
  warnings: ['model not loaded'],
};

describe('BoardRecognitionController (KS-2363 contract)', () => {
  let service: { recognize: jest.Mock };
  let controller: BoardRecognitionController;

  beforeEach(() => {
    service = { recognize: jest.fn().mockResolvedValue(MOCK_RESPONSE) };
    controller = new BoardRecognitionController(
      service as unknown as BoardRecognitionService,
    );
  });

  it('passes the file and profile=auto by default', async () => {
    const file = makeFile();
    const res = await controller.recognize(file, {} as RecognizeBoardDto);

    expect(res).toEqual(MOCK_RESPONSE);
    expect(service.recognize).toHaveBeenCalledWith(file, 'auto');
  });

  it.each<BoardRecognitionProfile>(['auto', 'maizelis', 'dvoretsky', 'generic'])(
    'passes profile=%s through to the service',
    async (profile) => {
      const file = makeFile();
      await controller.recognize(file, { profile });
      expect(service.recognize).toHaveBeenCalledWith(file, profile);
    },
  );

  it('throws 400 image_too_large when multer flags the file as truncated', async () => {
    const truncated = makeFile({ truncated: true } as unknown as Partial<Express.Multer.File>);
    await expect(
      controller.recognize(truncated, {} as RecognizeBoardDto),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.recognize).not.toHaveBeenCalled();
  });
});
