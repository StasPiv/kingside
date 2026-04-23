import { NotFoundException } from '@nestjs/common';
import { LessonsI18nController } from './i18n.controller';

jest.mock('fs');
import * as fs from 'fs';
const fsMock = fs as jest.Mocked<typeof fs>;

describe('LessonsI18nController (KS-1787)', () => {
  let controller: LessonsI18nController;

  beforeEach(() => {
    controller = new LessonsI18nController();
    jest.clearAllMocks();
  });

  it('GET /lessons/i18n/ru → читает и возвращает JSON', () => {
    const fake = { beginner: { title: 'Начинающий' } };
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify(fake) as any);

    const res = controller.getLessonsI18n('ru');
    expect(res).toEqual(fake);
  });

  it('GET /lessons/i18n/en → файла нет, возвращает {} (200)', () => {
    fsMock.existsSync.mockReturnValue(false);
    const res = controller.getLessonsI18n('en');
    expect(res).toEqual({});
  });

  it('GET /lessons/i18n/fr → 404 NotFoundException', () => {
    expect(() => controller.getLessonsI18n('fr')).toThrow(NotFoundException);
  });

  it('GET /lessons/i18n/../../etc/passwd → 404 (не-валидный lng)', () => {
    expect(() => controller.getLessonsI18n('../../etc/passwd')).toThrow(NotFoundException);
  });

  it('испорченный JSON → 404', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue('not-a-json' as any);
    expect(() => controller.getLessonsI18n('ru')).toThrow(NotFoundException);
  });
});
