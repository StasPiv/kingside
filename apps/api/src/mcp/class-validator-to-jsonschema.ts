/**
 * KS-2952 / ADR-061 §9 (отступление от ADR).
 *
 * Конвертер `class-validator` метаданных в JSON Schema. Самописный, потому
 * что внешний пакет `class-validator-jsonschema` имеет peer-зависимость
 * `class-validator@^0.14`, а у нас `^0.15.1`; кастомные npm-флаги (`--legacy-peer-deps`)
 * через MCP-тул `npm_install` не пробрасываются, корневые `overrides`
 * npm 8 отрабатывает после peer-check'а, понижение `class-validator`
 * рискованно для существующих DTO. Координатор одобрил inline-реализацию
 * (см. историю KS-2952). При добавлении новых валидаторов в DTO нужно
 * расширять этот конвертер; неподдерживаемые → `{}` + warn-log.
 *
 * Поддерживаемые декораторы (ADR-061 §9 backbone):
 *  - `@IsString`, `@IsInt`, `@IsNumber`, `@IsBoolean`, `@IsArray`,
 *    `@IsObject`, `@IsEnum`, `@IsUUID`, `@IsEmail`;
 *  - `@IsOptional` (определяет required[]);
 *  - `@Min`, `@Max`, `@MinLength`, `@MaxLength`, `@IsIn`,
 *    `@ArrayMinSize`, `@ArrayMaxSize`;
 *  - nested DTO через `@Type(() => Child)` (class-transformer) +
 *    рекурсивное построение схемы для Child.
 *
 * Возвращаемый формат — JSON Schema draft-07-совместимое подмножество,
 * как ожидает MCP-протокол: `{type: 'object', properties: {...},
 * required: [...]}`.
 */
import 'reflect-metadata';
import { getMetadataStorage } from 'class-validator';

export interface JsonSchemaProperty {
  type?: string;
  format?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  description?: string;
  nullable?: boolean;
  // Для отладки/неизвестных декораторов — пустой объект «любой тип».
}

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * Список валидаторов, которые мы знаем (по `ValidationMetadata.name`).
 * Если встретили name вне этого списка — логируем warn и пропускаем.
 */
/**
 * `name` valid в class-validator v0.15: для `@IsString` `name='isString'`,
 * `type='customValidation'`. Для `@IsOptional` — `name='isOptional'`,
 * `type='conditionalValidation'` (особый случай — обрабатываем по `type`).
 */
const KNOWN_VALIDATORS = new Set([
  'isString',
  'isInt',
  'isNumber',
  'isBoolean',
  'isArray',
  'isObject',
  'isEnum',
  'isUuid',
  'isEmail',
  'min',
  'max',
  'minLength',
  'maxLength',
  'isIn',
  'arrayMinSize',
  'arrayMaxSize',
  'nestedValidation',
]);

type WarnFn = (msg: string) => void;

/**
 * Преобразует DTO-класс в JSON Schema object.
 *
 * `seen` — защита от циклов в self-referencing DTO (StudyA → StudyA[]).
 * При повторной встрече класса возвращаем `{type: 'object'}` без раскрытия.
 */
export function classToJsonSchema(
  // eslint-disable-next-line @typescript-eslint/ban-types
  cls: Function,
  options: { warn?: WarnFn; seen?: Set<Function> } = {},
): JsonSchemaObject {
  const warn = options.warn ?? (() => {});
  const seen = options.seen ?? new Set();
  if (seen.has(cls)) {
    return { type: 'object', properties: {} };
  }
  seen.add(cls);

  const storage = getMetadataStorage();
  // getTargetValidationMetadatas обходит цепочку прототипов — учитывает
  // унаследованные DTO (extends). Параметры — (target, parent, always, groups).
  const metadatas = storage.getTargetValidationMetadatas(
    cls,
    '',
    true,
    false,
  );

  // Группируем метаданные по полю.
  const byField = new Map<string, MetadataLike[]>();
  for (const m of metadatas) {
    const arr = byField.get(m.propertyName) ?? [];
    arr.push(m as unknown as MetadataLike);
    byField.set(m.propertyName, arr);
  }

  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const [field, mds] of byField.entries()) {
    let isOptional = false;
    const prop: JsonSchemaProperty = {};

    for (const m of mds) {
      // @IsOptional() — type='conditionalValidation', этот случай
      // обрабатываем отдельно (см. class-validator v0.15).
      if (m.type === 'conditionalValidation') {
        isOptional = true;
        continue;
      }

      const name = m.name ?? m.type;
      if (!name) continue;

      if (!KNOWN_VALIDATORS.has(name)) {
        warn(
          `[mcp:schema] Неизвестный валидатор '${name}' на ${cls.name}.${field}, пропускаю (fallback {})`,
        );
        continue;
      }

      switch (name) {
        case 'isString':
          prop.type = 'string';
          break;
        case 'isInt':
          prop.type = 'integer';
          break;
        case 'isNumber':
          prop.type = 'number';
          break;
        case 'isBoolean':
          prop.type = 'boolean';
          break;
        case 'isArray':
          prop.type = 'array';
          if (!prop.items) prop.items = {};
          break;
        case 'isObject':
          prop.type = 'object';
          break;
        case 'isUuid':
          prop.type = 'string';
          prop.format = 'uuid';
          break;
        case 'isEmail':
          prop.type = 'string';
          prop.format = 'email';
          break;
        case 'isEnum':
        case 'isIn': {
          const allowed = m.constraints?.[0];
          if (Array.isArray(allowed)) {
            prop.enum = [...allowed];
          } else if (
            allowed &&
            typeof allowed === 'object' &&
            !Array.isArray(allowed)
          ) {
            // @IsEnum(MyEnum) — class-validator принимает enum-объект.
            prop.enum = Object.values(allowed).filter(
              (v) => typeof v === 'string' || typeof v === 'number',
            );
          }
          break;
        }
        case 'min':
          prop.minimum = numConstraint(m, 0);
          if (!prop.type) prop.type = 'number';
          break;
        case 'max':
          prop.maximum = numConstraint(m, 0);
          if (!prop.type) prop.type = 'number';
          break;
        case 'minLength':
          prop.minLength = numConstraint(m, 0);
          if (!prop.type) prop.type = 'string';
          break;
        case 'maxLength':
          prop.maxLength = numConstraint(m, 0);
          if (!prop.type) prop.type = 'string';
          break;
        case 'arrayMinSize':
          prop.minItems = numConstraint(m, 0);
          prop.type = 'array';
          if (!prop.items) prop.items = {};
          break;
        case 'arrayMaxSize':
          prop.maxItems = numConstraint(m, 0);
          prop.type = 'array';
          if (!prop.items) prop.items = {};
          break;
        case 'nestedValidation': {
          // @ValidateNested() — пробуем найти класс через
          // `class-transformer` метаданные (`design:type`/`Type()`).
          const childType = resolveNestedType(cls, field);
          if (childType) {
            const childSchema = classToJsonSchema(childType, {
              warn,
              seen,
            });
            if (prop.type === 'array' || mds.some((x) => x.name === 'isArray')) {
              prop.type = 'array';
              prop.items = childSchema;
            } else {
              prop.type = 'object';
              prop.properties = childSchema.properties;
              if (childSchema.required) {
                prop.required = childSchema.required;
              }
            }
          } else {
            warn(
              `[mcp:schema] Не удалось определить тип nested DTO для ` +
                `${cls.name}.${field} (нет @Type(()=>Child))`,
            );
            prop.type = prop.type ?? 'object';
          }
          break;
        }
        default:
          // safety — не должны сюда попадать, KNOWN_VALIDATORS отфильтровал.
          break;
      }
    }

    properties[field] = prop;
    if (!isOptional) required.push(field);
  }

  const schema: JsonSchemaObject = {
    type: 'object',
    properties,
  };
  if (required.length > 0) schema.required = required;
  return schema;
}

// eslint-disable-next-line @typescript-eslint/ban-types
function resolveNestedType(cls: Function, field: string): Function | null {
  // class-transformer хранит метаданные в `__decorated__`/getMetadataStorage,
  // но публичного API без импорта class-transformer внутрь нет. Здесь
  // используем `Reflect.getMetadata('design:type', ...)` как первый
  // источник — TS-эмиссия типа поля. Для массивов design:type=Array,
  // тогда уважаем `@Type(()=>Child)` через дополнительный путь.
  const proto = (cls as { prototype?: object }).prototype;
  if (!proto) return null;
  const designType: unknown = Reflect.getMetadata('design:type', proto, field);
  if (typeof designType === 'function' && designType !== Array) {
    return designType as unknown as Function;
  }
  // class-transformer хранит type-functions в собственном MetadataStorage.
  // Чтобы не вводить зависимость на class-transformer внутрь конвертера,
  // подсматриваем глобальное хранилище через require.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const ct = require('class-transformer');
    if (ct?.defaultMetadataStorage) {
      const meta = ct.defaultMetadataStorage.findTypeMetadata(cls, field);
      if (meta?.typeFunction) {
        return meta.typeFunction();
      }
    }
  } catch {
    /* class-transformer не доступен — отдадим null */
  }
  return null;
}

/**
 * Внутренний слабо-типизированный shape ValidationMetadata.
 * class-validator v0.15 называет поле `name`; некоторые ранние версии —
 * `type`. Поддерживаем оба.
 */
interface MetadataLike {
  name?: string;
  type?: string;
  propertyName: string;
  constraints?: unknown[];
}

function numConstraint(m: MetadataLike, idx: number): number | undefined {
  const v = m.constraints?.[idx];
  return typeof v === 'number' ? v : undefined;
}
