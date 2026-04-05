import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSavedFilterDto } from './dto/create-saved-filter.dto';
import { UpdateSavedFilterDto } from './dto/update-saved-filter.dto';

const MAX_FILTERS_PER_USER = 20;

@Injectable()
export class SavedFilterService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(userId: string) {
    return this.prisma.savedFilter.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(userId: string, dto: CreateSavedFilterDto) {
    const count = await this.prisma.savedFilter.count({ where: { userId } });
    if (count >= MAX_FILTERS_PER_USER) {
      throw new BadRequestException(
        `Maximum ${MAX_FILTERS_PER_USER} saved filters allowed`,
      );
    }

    return this.prisma.savedFilter.create({
      data: {
        userId,
        name: dto.name,
        category: dto.category || null,
        tags: dto.tags || null,
        search: dto.search || null,
        sortOrder: dto.sortOrder || null,
      },
    });
  }

  async update(userId: string, id: string, dto: UpdateSavedFilterDto) {
    const filter = await this.prisma.savedFilter.findUnique({ where: { id } });
    if (!filter) throw new NotFoundException('Saved filter not found');
    if (filter.userId !== userId) throw new ForbiddenException();

    return this.prisma.savedFilter.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.category !== undefined && { category: dto.category || null }),
        ...(dto.tags !== undefined && { tags: dto.tags || null }),
        ...(dto.search !== undefined && { search: dto.search || null }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder || null }),
      },
    });
  }

  async remove(userId: string, id: string) {
    const filter = await this.prisma.savedFilter.findUnique({ where: { id } });
    if (!filter) throw new NotFoundException('Saved filter not found');
    if (filter.userId !== userId) throw new ForbiddenException();
    await this.prisma.savedFilter.delete({ where: { id } });
    return { deleted: true };
  }
}
