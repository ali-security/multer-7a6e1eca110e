var is = require('type-is')
var Busboy = require('busboy')
var extend = require('xtend')
var appendField = require('append-field')

var Counter = require('./counter')
var MulterError = require('./multer-error')
var FileAppender = require('./file-appender')
var removeUploadedFiles = require('./remove-uploaded-files')

// Default cap on field-name bracket nesting depth (a[0][1]...). Upstream leaves
// limits.fieldNestingDepth unset (effectively Infinity), which keeps the
// GHSA-72gw-mp4g-v24j uncontrolled-recursion DoS open unless the consumer opts
// in. Sealed builds apply this default so protection is on out of the box; it
// is far above any realistic form nesting and callers can override or disable
// it via limits.fieldNestingDepth (set Infinity to restore upstream behavior).
var DEFAULT_FIELD_NESTING_DEPTH = 32

// append-field turns a bracket group whose contents are all digits into an
// array index, so `a[3]` produces an array of length 4. The index itself is
// unbounded, which means a single field name can materialize a sparse array
// with a very large length. That costs append-field almost nothing, but it is
// the application that pays when it later iterates or serializes req.body, and
// until now there was no limit to opt into.
function exceedsArrayIndexLimit (fieldname, limit) {
  // Only field names append-field parses as a bracket path build an array;
  // names it stores as a literal key (e.g. a[6]suffix, [6]) never do, so they
  // must not be rejected by the index limit.
  if (!/^[^[]+(?:\[[^\]]+\])*(?:\[\])?$/.test(fieldname)) return false

  var pattern = /\[(\d+)\]/g
  var match

  while ((match = pattern.exec(fieldname)) !== null) {
    if (Number(match[1]) > limit) return true
  }

  return false
}

function drainStream (stream) {
  stream.on('readable', () => {
    while (stream.read() !== null) {}
  })
}

function makeMiddleware (setup) {
  return function multerMiddleware (req, res, next) {
    if (!is(req, ['multipart'])) return next()

    var options = setup()

    var limits = options.limits
    var storage = options.storage
    var fileFilter = options.fileFilter
    var fileStrategy = options.fileStrategy
    var preservePath = options.preservePath

    req.body = Object.create(null)

    var busboy
    var appender = null
    var isDone = false
    var readFinished = false
    var errorOccured = false
    var abortCleanupDone = false
    var abortRemovedFiles = new Set()
    var pendingWrites = new Counter()
    var uploadedFiles = []
    var pendingFiles = []

    function done (err) {
      if (isDone) return
      isDone = true
      if (busboy) {
        req.unpipe(busboy)
        setImmediate(() => {
          busboy.removeAllListeners()
        })
      }
      drainStream(req)
      req.resume()
      next(err)
    }

    function indicateDone () {
      if (readFinished && pendingWrites.isZero() && !errorOccured) done()
    }

    function abortWithError (uploadError) {
      if (errorOccured) return
      errorOccured = true

      pendingWrites.onceZero(function finishAbort () {
        // Mark that the abort cleanup has committed its removal list. A file
        // whose engine completes after this point was not in that list, so the
        // completion callback must remove it directly (see _handleFile).
        abortCleanupDone = true

        function remove (file, cb) {
          storage._removeFile(req, file, cb)
        }

        var pendingToRemove = pendingFiles.filter(function (f) { return f.path })
        pendingToRemove.forEach(function (f) { abortRemovedFiles.add(f) })

        var filesToRemove = uploadedFiles.concat(pendingToRemove)
        pendingFiles = []

        removeUploadedFiles(filesToRemove, remove, function (err, storageErrors) {
          if (err) return done(err)

          uploadError.storageErrors = storageErrors
          done(uploadError)
        })
      })
    }

    function abortWithCode (code, optionalField) {
      abortWithError(new MulterError(code, optionalField))
    }

    function handleRequestFailure (err) {
      if (isDone) return
      if (busboy) busboy.destroy(err)
      abortWithError(err)
    }

    req.on('error', function (err) {
      handleRequestFailure(err || new Error('Request error'))
    })

    req.on('aborted', function () {
      handleRequestFailure(new Error('Request aborted'))
    })

    req.on('close', function () {
      if (req.readableEnded) return
      handleRequestFailure(new Error('Request closed'))
    })

    try {
      busboy = Busboy({ headers: req.headers, limits: limits, preservePath: preservePath })
    } catch (err) {
      return next(err)
    }

    appender = new FileAppender(fileStrategy, req)

    // handle text field data
    busboy.on('field', function (fieldname, value, { nameTruncated, valueTruncated }) {
      if (fieldname == null) return abortWithCode('MISSING_FIELD_NAME')
      if (nameTruncated) return abortWithCode('LIMIT_FIELD_KEY')
      if (valueTruncated) return abortWithCode('LIMIT_FIELD_VALUE', fieldname)

      // Work around bug in Busboy (https://github.com/mscdex/busboy/issues/6)
      if (limits && Object.prototype.hasOwnProperty.call(limits, 'fieldNameSize')) {
        if (fieldname.length > limits.fieldNameSize) return abortWithCode('LIMIT_FIELD_KEY')
      }

      var fieldNestingDepth = limits && Object.prototype.hasOwnProperty.call(limits, 'fieldNestingDepth')
        ? limits.fieldNestingDepth
        : DEFAULT_FIELD_NESTING_DEPTH
      if (fieldname.split('[').length - 1 > fieldNestingDepth) return abortWithCode('LIMIT_FIELD_NESTING', fieldname)

      if (limits && Object.prototype.hasOwnProperty.call(limits, 'fieldArrayIndexLimit')) {
        if (exceedsArrayIndexLimit(fieldname, limits.fieldArrayIndexLimit)) {
          return abortWithCode('LIMIT_FIELD_ARRAY_INDEX', fieldname)
        }
      }

      appendField(req.body, fieldname, value)
    })

    // handle files
    busboy.on('file', function (fieldname, fileStream, { filename, encoding, mimeType }) {
      var pendingWritesIncremented = false
      var aborting = false
      var accepted = false
      var fileSizeLimitReached = false

      function decrementPendingWrites () {
        if (!pendingWritesIncremented) return
        pendingWritesIncremented = false
        pendingWrites.decrement()
      }

      fileStream.on('error', function (err) {
        decrementPendingWrites()
        abortWithError(err)
      })

      // Register 'limit' synchronously so an async fileFilter can't miss it.
      // Only abort once the file has been accepted.
      fileStream.on('limit', function () {
        fileSizeLimitReached = true
        if (accepted) {
          aborting = true
          abortWithCode('LIMIT_FILE_SIZE', fieldname)
        }
      })

      if (fieldname == null) return abortWithCode('MISSING_FIELD_NAME')

      // don't attach to the files object, if there is no file
      if (!filename) return fileStream.resume()

      // Work around bug in Busboy (https://github.com/mscdex/busboy/issues/6)
      if (limits && Object.prototype.hasOwnProperty.call(limits, 'fieldNameSize')) {
        if (fieldname.length > limits.fieldNameSize) return abortWithCode('LIMIT_FIELD_KEY')
      }

      var file = {
        fieldname: fieldname,
        originalname: filename,
        encoding: encoding,
        mimetype: mimeType
      }

      var placeholder = appender.insertPlaceholder(file)

      fileFilter(req, file, function (err, includeFile) {
        if (errorOccured) {
          appender.removePlaceholder(placeholder)
          return fileStream.resume()
        }

        if (err) {
          appender.removePlaceholder(placeholder)
          return abortWithError(err)
        }

        if (!includeFile) {
          appender.removePlaceholder(placeholder)
          return fileStream.resume()
        }

        // 'limit' may have fired while an async fileFilter was pending.
        if (fileSizeLimitReached) {
          appender.removePlaceholder(placeholder)
          return abortWithCode('LIMIT_FILE_SIZE', fieldname)
        }

        accepted = true
        pendingWritesIncremented = true
        pendingWrites.increment()

        Object.defineProperty(file, 'stream', {
          configurable: true,
          enumerable: false,
          value: fileStream
        })

        pendingFiles.push(file)

        storage._handleFile(req, file, function (err, info) {
          var idx = pendingFiles.indexOf(file)
          if (idx !== -1) pendingFiles.splice(idx, 1)

          if (aborting) {
            appender.removePlaceholder(placeholder)
            uploadedFiles.push(extend(file, info))
            return decrementPendingWrites()
          }

          if (err) {
            appender.removePlaceholder(placeholder)

            // An aborted or malformed request destroys the file stream while
            // the engine may already have written part of the file. The engine
            // reports that failure here, after the file left pendingFiles, so
            // hand a partially written file to the abort cleanup (or remove it
            // directly if that cleanup already ran without it).
            if (errorOccured && file.path && !abortRemovedFiles.has(file)) {
              if (abortCleanupDone) {
                return storage._removeFile(req, file, function () {
                  decrementPendingWrites()
                })
              }

              uploadedFiles.push(file)
            }

            decrementPendingWrites()
            return abortWithError(err)
          }

          var fileInfo = extend(file, info)

          // If the abort cleanup already ran while the engine was still
          // naming/writing this file, finishAbort has drained uploadedFiles and
          // will not run again, so pushing here would orphan the file. Remove it
          // directly (this also covers engines slower than the abort: multer-s3,
          // GridFS, async filename). While the abort is still waiting on pending
          // writes, fall through so finishAbort cleans it and keeps storageErrors.
          if (abortCleanupDone) {
            // finishAbort already removed this file if it had a path when the
            // abort ran; removing again could double-clean an engine that does
            // not support it. Just settle the bookkeeping in that case.
            if (abortRemovedFiles.has(file)) {
              appender.removePlaceholder(placeholder)
              decrementPendingWrites()
              return
            }

            return storage._removeFile(req, fileInfo, function () {
              appender.removePlaceholder(placeholder)
              decrementPendingWrites()
            })
          }

          appender.replacePlaceholder(placeholder, fileInfo)
          uploadedFiles.push(fileInfo)
          decrementPendingWrites()
          indicateDone()
        })
      })
    })

    busboy.on('error', function (err) { abortWithError(err) })
    busboy.on('partsLimit', function () { abortWithCode('LIMIT_PART_COUNT') })
    busboy.on('filesLimit', function () { abortWithCode('LIMIT_FILE_COUNT') })
    busboy.on('fieldsLimit', function () { abortWithCode('LIMIT_FIELD_COUNT') })
    busboy.on('close', function () {
      readFinished = true
      indicateDone()
    })

    req.pipe(busboy)
  }
}

module.exports = makeMiddleware
