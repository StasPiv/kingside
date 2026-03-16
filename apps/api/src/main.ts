import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  const corsOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
    : ['http://localhost:5173'];
  app.enableCors({
    origin: corsOrigins,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));

  const port = process.env.PORT || 3001;
  await app.listen(port, '0.0.0.0');
  console.log(`Server running on http://0.0.0.0:${port}`);
}

bootstrap();
