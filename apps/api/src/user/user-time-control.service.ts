import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTimeControlDto } from './dto/create-time-control.dto';

const MAX_TIME_CONTROLS_PER_USER = 20;

@Injectable()
export class UserTimeControlService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllByUser(userId: string) {
    return this.prisma.userTimeControl.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(userId: string, dto: CreateTimeControlDto) {
    const count = await this.prisma.userTimeControl.count({
      where: { userId },
    });

    if (count >= MAX_TIME_CONTROLS_PER_USER) {
      throw new BadRequestException(
        `Maximum of ${MAX_TIME_CONTROLS_PER_USER} custom time controls allowed`,
      );
    }

    return this.prisma.userTimeControl.create({
      data: {
        userId,
        name: dto.name,
        initialSec: dto.initialSec,
        incrementSec: dto.incrementSec,
      },
    });
  }

  async remove(userId: string, id: string) {
    const timeControl = await this.prisma.userTimeControl.findUnique({
      where: { id },
    });

    if (!timeControl) {
      throw new NotFoundException('Time control not found');
    }

    if (timeControl.userId !== userId) {
      throw new ForbiddenException();
    }

    await this.prisma.userTimeControl.delete({ where: { id } });
  }
}
