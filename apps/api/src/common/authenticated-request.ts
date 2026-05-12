import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    username: string | null;
    // KS-2786: email из pending OAuth JWT (только для pending: префиксов),
    // используется в setUsername для сохранения email Google/Facebook-юзера в БД.
    email?: string | null;
  };
}
