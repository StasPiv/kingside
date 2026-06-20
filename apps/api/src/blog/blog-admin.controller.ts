/**
 * KS-4410 / ADR-137 rev2. Админ-маршруты блога. Защита —
 * `JwtAuthGuard + AdminUserGuard` (whitelist `KS_ADMIN_USERS` env,
 * KS-2108). Без авторизации → 401; не-админ → 403.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminUserGuard } from '../auth/admin-user.guard';
import { BlogAdminService } from './blog-admin.service';
import {
  CreateBlogAuthorDto,
  CreateBlogPostDto,
  ListAdminBlogPostsDto,
  PreviewBlogMarkdownDto,
  UpdateBlogAuthorDto,
  UpdateBlogPostDto,
  UpdateBlogPostStatusDto,
} from './dto/blog-admin.dto';

@UseGuards(JwtAuthGuard, AdminUserGuard)
@Controller('admin/blog')
export class BlogAdminController {
  constructor(private readonly admin: BlogAdminService) {}

  // ─── posts ─────────────────────────────────────────────────────────

  @Get('posts')
  listPosts(@Query() query: ListAdminBlogPostsDto) {
    return this.admin.listPosts(query);
  }

  @Get('posts/:id')
  getPost(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.admin.getPost(id);
  }

  @Post('posts')
  createPost(@Body() body: CreateBlogPostDto) {
    return this.admin.createPost(body);
  }

  @Put('posts/:id')
  updatePost(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateBlogPostDto,
  ) {
    return this.admin.updatePost(id, body);
  }

  @Delete('posts/:id')
  async deletePost(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ deleted: true }> {
    await this.admin.deletePost(id);
    return { deleted: true };
  }

  @Patch('posts/:id/status')
  updateStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateBlogPostStatusDto,
  ) {
    return this.admin.setStatus(id, body.status);
  }

  @Post('posts/preview')
  preview(@Body() body: PreviewBlogMarkdownDto) {
    return this.admin.previewMarkdown(body.bodyMd);
  }

  // ─── authors ───────────────────────────────────────────────────────

  @Get('authors')
  listAuthors() {
    return this.admin.listAuthors();
  }

  @Get('authors/:id')
  getAuthor(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.admin.getAuthor(id);
  }

  @Post('authors')
  createAuthor(@Body() body: CreateBlogAuthorDto) {
    return this.admin.createAuthor(body);
  }

  @Put('authors/:id')
  updateAuthor(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateBlogAuthorDto,
  ) {
    return this.admin.updateAuthor(id, body);
  }

  @Delete('authors/:id')
  async deleteAuthor(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ deleted: true }> {
    await this.admin.deleteAuthor(id);
    return { deleted: true };
  }
}
