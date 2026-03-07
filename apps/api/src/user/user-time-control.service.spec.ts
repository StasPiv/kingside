import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { UserTimeControlService } from './user-time-control.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UserTimeControlService', () => {
  let service: UserTimeControlService;
  let prisma: {
    userTimeControl: {
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      findUnique: jest.Mock;
      delete: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      userTimeControl: {
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserTimeControlService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(UserTimeControlService);
  });

  describe('findAllByUser', () => {
    it('should return time controls for user', async () => {
      const userId = 'user-1';
      const expected = [
        { id: 'tc-1', userId, initialSec: 300, incrementSec: 5 },
      ];
      prisma.userTimeControl.findMany.mockResolvedValue(expected);

      const result = await service.findAllByUser(userId);

      expect(result).toEqual(expected);
      expect(prisma.userTimeControl.findMany).toHaveBeenCalledWith({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('create', () => {
    it('should create a time control', async () => {
      const userId = 'user-1';
      const dto = { initialSec: 300, incrementSec: 5, name: 'My blitz' };
      const expected = { id: 'tc-1', userId, ...dto };

      prisma.userTimeControl.count.mockResolvedValue(0);
      prisma.userTimeControl.create.mockResolvedValue(expected);

      const result = await service.create(userId, dto);

      expect(result).toEqual(expected);
    });

    it('should throw BadRequestException when limit reached', async () => {
      prisma.userTimeControl.count.mockResolvedValue(20);

      await expect(
        service.create('user-1', { initialSec: 300, incrementSec: 0 }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('remove', () => {
    it('should delete a time control owned by user', async () => {
      const userId = 'user-1';
      const id = 'tc-1';
      prisma.userTimeControl.findUnique.mockResolvedValue({ id, userId });
      prisma.userTimeControl.delete.mockResolvedValue({ id });

      await service.remove(userId, id);

      expect(prisma.userTimeControl.delete).toHaveBeenCalledWith({
        where: { id },
      });
    });

    it('should throw NotFoundException if not found', async () => {
      prisma.userTimeControl.findUnique.mockResolvedValue(null);

      await expect(service.remove('user-1', 'tc-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException if not owner', async () => {
      prisma.userTimeControl.findUnique.mockResolvedValue({
        id: 'tc-1',
        userId: 'other-user',
      });

      await expect(service.remove('user-1', 'tc-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
