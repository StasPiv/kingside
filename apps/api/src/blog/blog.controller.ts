/**
 * KS-4409 / ADR-137 rev2. Публичные маршруты блога. Все эндпоинты
 * без авторизации — статьи публичны.
 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { BlogService } from './blog.service';
import { ListBlogPostsDto } from './dto/list-blog-posts.dto';
import { GetBlogPostDto } from './dto/get-blog-post.dto';

@Controller('blog')
export class BlogController {
  constructor(private readonly service: BlogService) {}

  /** GET /blog/posts?locale=ru&page=1&tag=... */
  @Get('posts')
  list(@Query() query: ListBlogPostsDto) {
    return this.service.listPosts(query);
  }

  /** GET /blog/posts/:slug?locale=ru */
  @Get('posts/:slug')
  get(@Param('slug') slug: string, @Query() query: GetBlogPostDto) {
    return this.service.getPost(slug, query.locale);
  }

  /** GET /blog/authors/:handle */
  @Get('authors/:handle')
  author(@Param('handle') handle: string) {
    return this.service.getAuthor(handle);
  }
}
