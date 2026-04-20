type AwaiterGenerator = {
  next: (value?: unknown) => IteratorResult<unknown>
  throw: (value?: unknown) => IteratorResult<unknown>
}

export function __awaiter(
  thisArg: unknown,
  _arguments: unknown,
  P: PromiseConstructor,
  generatorFactory: (...args: unknown[]) => AwaiterGenerator,
) {
  function adopt(value: unknown) {
    return value instanceof P ? value : new P((resolve) => resolve(value))
  }
  const args = Array.isArray(_arguments) ? _arguments : []

  return new P((resolve, reject) => {
    let generator: AwaiterGenerator

    function fulfilled(value: unknown) {
      try {
        step(generator.next(value))
      } catch (error) {
        reject(error)
      }
    }

    function rejected(value: unknown) {
      try {
        step(generator.throw(value))
      } catch (error) {
        reject(error)
      }
    }

    function step(result: IteratorResult<unknown>) {
      if (result.done) {
        resolve(result.value)
      } else {
        adopt(result.value).then(fulfilled, rejected)
      }
    }

    step((generator = generatorFactory.apply(thisArg, args)).next())
  })
}

export function __rest(source: Record<string, unknown>, exclude: readonly PropertyKey[]) {
  const target: Record<PropertyKey, unknown> = {}
  for (const prop in source) {
    if (Object.prototype.hasOwnProperty.call(source, prop) && exclude.indexOf(prop) < 0) {
      target[prop] = source[prop]
    }
  }
  if (source != null && typeof Object.getOwnPropertySymbols === 'function') {
    for (const prop of Object.getOwnPropertySymbols(source)) {
      if (
        exclude.indexOf(prop) < 0 &&
        Object.prototype.propertyIsEnumerable.call(source, prop)
      ) {
        target[prop] = source[prop as unknown as keyof typeof source]
      }
    }
  }
  return target as unknown as Record<string, unknown>
}
