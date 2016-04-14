import { BaseError } from 'make-error'

// ===================================================================

if (
  typeof Promise !== 'function' ||
  typeof Promise.reject !== 'function' ||
  typeof Promise.resolve !== 'function'
) {
  throw new Error('a standard Promise implementation is required (https://github.com/JsCommunity/promise-toolbox#usage)')
}

// ===================================================================

const _endsWith = (str, suffix, pos = str.length) => {
  pos -= suffix.length
  return pos >= 0 && str.indexOf(suffix, pos) === pos
}

const _isArray = Array.isArray || ((value) => value instanceof Array)

const _isLength = (value) => (
  typeof value === 'number' &&
  value >= 0 && value < Infinity &&
  Math.floor(value) === value
)

const _isArrayLike = (value) => (
  value &&
  typeof value !== 'function' &&
  _isLength(value.length)
)

const _isIterable = typeof Symbol === 'function'
  ? (value) => value && typeof value[Symbol.iterator] === 'function'
  : () => false

const _noop = () => {}

// -------------------------------------------------------------------

const _forArray = (array, iteratee) => {
  const { length } = array
  for (let i = 0; i < length; ++i) {
    iteratee(array[i], i, array)
  }
}

const _forIn = (object, iteratee) => {
  for (const key in object) {
    iteratee(object[key], key, object)
  }
}

const _forIterable = (iterable, iteratee) => {
  const iterator = iterable[Symbol.iterator]()

  let current
  while (!(current = iterator.next()).done) {
    iteratee(current.value, null, iterable)
  }
}

const { hasOwnProperty } = Object.prototype
const _forOwn = (object, iteratee) => {
  for (const key in object) {
    if (hasOwnProperty.call(object, key)) {
      iteratee(object[key], key, object)
    }
  }
}

const _forEach = (collection, iteratee) => _isArray(collection)
  ? _forArray(collection, iteratee)
  : _isIterable(collection)
    ? _forIterable(collection, iteratee)
    : _isArrayLike(collection)
      ? _forArray(collection, iteratee)
      : _forOwn(collection, iteratee)

const _map = (collection, iteratee) => {
  const result = _isArrayLike(collection)
    ? new Array(collection.length)
    : {}

  // If iteratee is not a function, simply returns the new container.
  if (iteratee) {
    _forEach(collection, (item, key) => {
      result[key] = iteratee(item, key, collection)
    })
  }

  return result
}

// ===================================================================

export const isPromise = (value) => (
  value != null &&
  typeof value.then === 'function'
)

// -------------------------------------------------------------------

const _makeAsyncIterator = (iterator) => (promises, cb) => {
  let mainPromise = Promise.resolve()

  iterator(promises, (promise, key) => {
    mainPromise = isPromise(promise)
      ? mainPromise.then(() => promise.then((value) => cb(value, key, promises)))
      : mainPromise.then(() => cb(promise, key, promises))
  })

  return mainPromise
}

const _wrap = (value) => isPromise(value)
  ? value
  : Promise.resolve(value)

const _wrapCall = (fn, args, thisArg) => {
  try {
    return _wrap(fn.apply(thisArg, args))
  } catch (error) {
    return Promise.reject(error)
  }
}

// ===================================================================

const _all = (promises, mapFn) => new Promise((resolve, reject) => {
  // mapFn may be undefined but it's okay :)
  let result = _map(promises, mapFn)

  let count = 1
  const onFulfillment0 = () => {
    if (--count === 0) {
      const tmp = result
      result = null
      resolve(tmp)
    }
  }

  const onFulfillment = (value, key) => {
    if (!result) {
      return
    }

    result[key] = value
    onFulfillment0()
  }

  const onRejection = (reason) => {
    if (!result) {
      return
    }

    result = null
    reject(reason)
  }

  _forEach(mapFn ? result : promises, (promise, key) => {
    ++count

    if (isPromise(promise)) {
      promise.then(
        (value) => onFulfillment(value, key),
        onRejection
      )
    } else {
      onFulfillment(promise, key)
    }
  })
  onFulfillment0()
})

// Returns a promise which resolves when all the promises in a
// collection have resolved or rejects with the reason of the first
// promise that rejects.
//
// Optionally a function can be provided to map all items in the
// collection before waiting for completion.
//
// Usage: promises::all([ mapFn ])
export function all (mapFn) {
  return _wrap(this).then((promises) => _all(promises, mapFn))
}

// -------------------------------------------------------------------

// Usage: promise::asCallback(cb)
export function asCallback (cb) {
  // cb can be undefined.
  if (cb) {
    this.then(
      (value) => cb(null, value),
      (error) => cb(error)
    ).then(null, _noop)
  }

  return this
}

export { asCallback as nodeify }

// -------------------------------------------------------------------

// Usage:
//
//     @cancellable
//     async fn (cancellation, other, args) {
//       cancellation.catch(() => {
//         // do stuff regarding the cancellation request.
//       })
//
//       // do other stuff.
//     }
export const cancellable = (target, name, descriptor) => {
  const fn = descriptor
    ? descriptor.value
    : target

  function newFn (...args) {
    let reject
    const cancellation = new Promise((_, reject_) => { // eslint-disable-line promise/param-names
      reject = reject_
    })
    cancellation.then(null, _noop)

    const promise = fn.call(this, cancellation, ...args)

    promise.cancel = reject

    return promise
  }

  return descriptor
    ? (descriptor.value = newFn, descriptor)
    : newFn
}

// -------------------------------------------------------------------

const _isOperationalError = (reason) => !(
  reason instanceof ReferenceError ||
  reason instanceof SyntaxError ||
  reason instanceof TypeError
)

// See: https://github.com/petkaantonov/bluebird/blob/d8907d15f0a1997a5d3c0526cd4da5ba1b135cfa/src/util.js#L7-L30
const _errorWrapper = { error: null }
const _tryCatch = (fn) => {
  try {
    return fn()
  } catch (error) {
    _errorWrapper.error = error
    return _errorWrapper
  }
}

const _matchError = (predicate, error) => {
  if (typeof predicate === 'function') {
    return predicate.prototype instanceof Error
      ? error instanceof predicate
      : predicate(error)
  }

  if (typeof predicate === 'object') {
    return (
      error != null &&
      _tryCatch(() => _forOwn(predicate, (value, prop) => {
        if (error[prop] !== value) {
          throw null // eslint-disable-line no-throw-literal
        }
      })) !== _errorWrapper
    )
  }
}

// Similar to `Promise#catch()` but:
// - support predicates
// - do not catch `ReferenceError`, `SyntaxError` or `TypeError`
//   unless they match a predicate because they are usually programmer
//   errors and should be handled separately.
export function catchPlus () {
  const n = arguments.length - 1

  let cb
  if (
    n < 0 ||
    typeof (cb = arguments[n]) !== 'function'
  ) {
    return this
  }

  let predicates
  if (n) {
    predicates = new Array(n)
    for (let i = 0; i < n; ++i) {
      predicates[i] = arguments[i]
    }
  }

  return _wrap(this).then(null, (reason) => {
    if (predicates) {
      for (let i = 0; i < n; ++i) {
        if (_matchError(predicates[i], reason)) {
          return cb(reason)
        }
      }
    } else if (_isOperationalError(reason)) {
      return cb(reason)
    }

    // Forward error without throwing (perf).
    return this
  })
}

// -------------------------------------------------------------------

// Discouraged but sometimes necessary way to create a promise.
export const defer = () => {
  let resolve, reject
  const promise = new Promise((resolve_, reject_) => { // eslint-disable-line promise/param-names
    resolve = resolve_
    reject = reject_
  })

  return {
    promise,
    reject,
    resolve
  }
}

// -------------------------------------------------------------------

// Usage: promise::delay(ms)
export function delay (ms) {
  return _wrap(this).then((value) => new Promise((resolve) => {
    setTimeout(() => resolve(value), ms)
  }))
}

// -------------------------------------------------------------------

export const makeAsyncIterator = (iterator) => {
  const asyncIterator = _makeAsyncIterator(iterator)

  return function (cb) {
    return _wrap(this)
      .then((promises) => asyncIterator(promises, cb))
      .then(_noop) // Resolves to undefined
  }
}

export const forArray = makeAsyncIterator(_forArray)
export const forEach = makeAsyncIterator(_forEach)
export const forIn = makeAsyncIterator(_forIn)
export const forIterable = makeAsyncIterator(_forIterable)
export const forOwn = makeAsyncIterator(_forOwn)

// -------------------------------------------------------------------

// Usage:
//
//     fromCallback((cb) => fs.readFile('foo.txt', cb))
//       .then((content) => {
//         console.log(content)
//       })
export const fromCallback = (fn) => new Promise((resolve, reject) => {
  fn((error, result) => error
    ? reject(error)
    : resolve(result)
  )
})

// -------------------------------------------------------------------

// Usage: join(p1, ..., pn, cb) or join([p1, ..., pn], cb)
export function join () {
  const n = arguments.length - 1
  const cb = arguments[n]

  let promises
  if (n === 0) {
    return new Promise((resolve) => resolve(cb()))
  } else if (n !== 1) {
    promises = new Array(n)
    for (let i = 0; i < n; ++i) {
      promises[i] = arguments[i]
    }
  } else if (!_isArrayLike(promises = arguments[0])) {
    return _wrap(promises).then((value) => cb(value))
  }

  return _all(promises).then((args) => cb.apply(null, args))
}

// -------------------------------------------------------------------

// Ponyfill for Promise.finally(cb)
//
// Usage: promise::lastly(cb)
export function lastly (cb) {
  return _wrap(this).then(
    (value) => _wrap(cb()).then(() => value),
    (reason) => _wrap(cb()).then(() => {
      throw reason
    })
  )
}
export { lastly as finally }

// -------------------------------------------------------------------

const _setFunctionNameAndLength = (() => {
  const _defineProperties = Object.defineProperties

  try {
    const f = _defineProperties(function () {}, {
      length: { value: 2 },
      name: { value: 'foo' }
    })

    if (f.length === 2 && f.name === 'foo') {
      return (fn, name, length) => _defineProperties(fn, {
        length: {
          configurable: true,
          value: length
        },
        name: {
          configurable: true,
          value: name
        }
      })
    }
  } catch (_) {}

  return (fn) => fn
})()

// Usage: fn::promisify([ context ])
export function promisify (context) {
  const fn = this

  return _setFunctionNameAndLength(function () {
    const { length } = arguments
    const args = new Array(length + 1)
    for (let i = 0; i < length; ++i) {
      args[i] = arguments[i]
    }

    return new Promise((resolve, reject) => {
      args[length] = (error, result) => error
        ? reject(error)
        : resolve(result)

      fn.apply(context || this, args)
    })
  }, fn.name, fn.length && fn.length - 1)
}

const _DEFAULT_PALL_MAPPER = (name, fn) => (
  !(_endsWith(name, 'Sync') || _endsWith(name, 'Async')) &&
  name
)

// Usage: obj::promisifyAll([ opts ])
export function promisifyAll ({
  mapper = _DEFAULT_PALL_MAPPER,
  target = {},
  context = this
} = {}) {
  _forIn(this, (value, name) => {
    let newName
    if (
      typeof value === 'function' &&
      (newName = mapper(name, value, this))
    ) {
      target[newName] = value::promisify(context)
    }
  })

  return target
}

// -------------------------------------------------------------------

const FN_FALSE = () => false
const FN_TRUE = () => true

const _reflectResolution = ((__proto__) => (value) => ({
  __proto__,
  value: () => value
}))({
  isFulfilled: FN_TRUE,
  isPending: FN_FALSE,
  isRejected: FN_FALSE,
  isResolved: FN_TRUE,
  reason: () => {
    throw new Error('no reason, the promise has resolved')
  }
})

const _reflectRejection = ((__proto__) => (reason) => ({
  __proto__,
  reason: () => reason
}))({
  isFulfilled: FN_FALSE,
  isPending: FN_FALSE,
  isRejected: FN_TRUE,
  isResolved: FN_FALSE,
  value: () => {
    throw new Error('no value, the promise has rejected')
  }
})

// Returns a promise that is always successful when this promise is
// settled. Its fulfillment value is an object that implements the
// PromiseInspection interface and reflects the resolution this
// promise.
//
// Usage: promise::reflect()
export function reflect () {
  return _wrap(this).then(
    _reflectResolution,
    _reflectRejection
  )
}

// -------------------------------------------------------------------

// Given a collection (array or object) which contains promises,
// return a promise that is fulfilled when all the items in the
// collection are either fulfilled or rejected.
//
// This promise will be fulfilled with a collection (of the same type,
// array or object) containing promise inspections.
//
// Usage: promises::settle()
export function settle () {
  return this::all((x) => x::reflect())
}

// -------------------------------------------------------------------

const _some = (promises, count) => new Promise((resolve, reject) => {
  let values = []
  let errors = []

  const onFulfillment = (value) => {
    if (!values) {
      return
    }

    values.push(value)
    if (--count === 0) {
      resolve(values)
      values = errors = null
    }
  }

  let acceptableErrors = -count
  const onRejection = (reason) => {
    if (!values) {
      return
    }

    errors.push(reason)
    if (--acceptableErrors === 0) {
      reject(errors)
      values = errors = null
    }
  }

  _forEach(promises, (promise) => {
    ++acceptableErrors
    _wrap(promise).then(onFulfillment, onRejection)
  })
})

// Usage: promises::some(count)
export function some (count) {
  return _wrap(this).then((promises) => _some(promises, count))
}

// -------------------------------------------------------------------

export class TimeoutError extends BaseError {
  constructor () {
    super('operation timed out')
  }
}

// Usage: promise::timeout(ms)
export function timeout (ms) {
  return new Promise((resolve, reject) => {
    let handle = setTimeout(() => {
      handle = null
      reject(new TimeoutError())

      if (typeof this.cancel === 'function') {
        this.cancel()
      }
    }, ms)

    _wrap(this).then(
      (value) => {
        handle !== null && clearTimeout(handle)
        resolve(value)
      },
      (reason) => {
        handle !== null && clearTimeout(handle)
        reject(reason)
      }
    )
  })
}

// -------------------------------------------------------------------

// Usage: fn::unpromisify()
export function unpromisify () {
  const fn = this
  return _setFunctionNameAndLength(function () {
    const n = arguments.length - 1
    let cb
    if (
      n < 0 ||
      typeof (cb = arguments[n]) !== 'function'
    ) {
      throw new Error('missing callback')
    }

    const args = new Array(n)
    for (let i = 0; i < n; ++i) {
      args[i] = arguments[i]
    }

    _wrapCall(fn, args, this).then(
      (result) => cb(null, result),
      (reason) => cb(reason)
    )
  }, fn.name, fn.length + 1)
}
