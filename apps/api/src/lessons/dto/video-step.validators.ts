/**
 * class-validator декоратор для `VideoStepPayloadDto.url` (KS-1808).
 * Логика и whitelist хостов живут в `@kingside/shared`
 * (`isAllowedVideoUrl`, `ALLOWED_VIDEO_HOSTS`) — то же правило используют
 * seed-линтер и фронт-компонент, чтобы словарь поддерживаемых embed-хостов
 * был один на все три точки входа.
 */

import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { ALLOWED_VIDEO_HOSTS, isAllowedVideoUrl } from '@kingside/shared';

export function IsVideoUrl(validationOptions?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isVideoUrl',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return isAllowedVideoUrl(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be an http(s) URL whose host is one of: ${ALLOWED_VIDEO_HOSTS.join(', ')}`;
        },
      },
    });
  };
}
