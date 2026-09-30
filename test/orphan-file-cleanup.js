/* eslint-env mocha */

var assert = require('assert')
var fs = require('fs')
var http = require('http')

var express = require('express')
var multer = require('../')
var rimraf = require('rimraf')
var temp = require('fs-temp')

// @see https://github.com/expressjs/multer/security/advisories/GHSA-3p4h-7m6x-2hcm
describe('orphan file cleanup on abort/malformed requests', function () {
  var uploadDir, server, port

  beforeEach(function (done) {
    temp.mkdir(function (err, dir) {
      if (err) return done(err)

      uploadDir = dir
      var upload = multer({ dest: dir })
      var app = express()

      app.post('/upload', upload.single('file'), function (req, res) {
        res.json({ success: true })
      })

      app.post('/upload-multi', upload.array('file', 2), function (req, res) {
        res.json({ success: true })
      })

      app.use(function (err, req, res, next) {
        res.status(400).json({ error: err.message || err.code })
      })

      server = app.listen(0, function () {
        port = server.address().port
        done()
      })
    })
  })

  afterEach(function (done) {
    server.close(function () {
      rimraf(uploadDir, done)
    })
  })

  it('should not leave orphan files when client aborts mid-upload', function (done) {
    this.timeout(5000)

    var boundary = 'AbortBound' + Date.now()
    var preamble =
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="test.bin"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n'
    var chunk = Buffer.alloc(64 * 1024, 0x5a)

    var req = http.request({
      hostname: 'localhost',
      port: port,
      path: '/upload',
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': Buffer.byteLength(preamble) + (chunk.length * 10)
      }
    })

    req.on('error', function () {})
    req.write(preamble)
    req.write(chunk)

    setTimeout(function () {
      req.destroy()

      setTimeout(function () {
        var files = fs.readdirSync(uploadDir)
        assert.strictEqual(files.length, 0, 'orphan files after client abort: ' + files.join(', '))
        done()
      }, 500)
    }, 50)
  })

  it('should not leave orphan files on truncated multipart', function (done) {
    this.timeout(5000)

    var boundary = 'TruncBound' + Date.now()
    var body =
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="test.bin"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n' +
      'ORPHAN FILE DATA'

    var req = http.request({
      hostname: 'localhost',
      port: port,
      path: '/upload',
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': Buffer.byteLength(body)
      }
    }, function (res) {
      res.resume()
      res.on('end', function () {
        setTimeout(function () {
          var files = fs.readdirSync(uploadDir)
          assert.strictEqual(files.length, 0, 'orphan files after truncated multipart: ' + files.join(', '))
          done()
        }, 500)
      })
    })

    req.on('error', function () {})
    req.write(body)
    req.end()
  })

  it('should not leave orphan files when a later file aborts after an earlier one completed', function (done) {
    this.timeout(5000)

    var boundary = 'CompletedBound' + Date.now()

    var partA =
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="done.bin"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n' +
      'COMPLETED FILE CONTENT\r\n'

    var partBStart =
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="aborted.bin"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n'

    var chunkB = Buffer.alloc(64 * 1024, 0x5a)

    var req = http.request({
      hostname: 'localhost',
      port: port,
      path: '/upload-multi',
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': Buffer.byteLength(partA) + Buffer.byteLength(partBStart) + (chunkB.length * 10)
      }
    })

    req.on('error', function () {})

    req.write(partA)
    req.write(partBStart)
    req.write(chunkB)

    setTimeout(function () {
      req.destroy()

      setTimeout(function () {
        var files = fs.readdirSync(uploadDir)
        assert.strictEqual(files.length, 0, 'orphan files after late abort: ' + files.join(', '))
        done()
      }, 500)
    }, 200)
  })
})

// A malformed request (here: the body ends without a closing boundary) makes
// busboy destroy the file stream it is currently feeding. When an earlier file
// of the same request is still being written, the abort cleanup waits for it,
// and in the meantime the destroyed file's engine reports its failure. The
// partially written file must still be removed once the cleanup runs.
describe('orphan file cleanup on malformed requests while an earlier file is in flight', function () {
  var uploadDir, server, port

  beforeEach(function (done) {
    temp.mkdir(function (err, dir) {
      if (err) return done(err)

      uploadDir = dir
      var storage = multer.diskStorage({
        destination: dir,
        filename: function (req, file, cb) {
          // keep the first file in flight until after the request has failed
          var delay = file.originalname === 'slow.bin' ? 300 : 0
          setTimeout(function () { cb(null, file.originalname) }, delay)
        }
      })
      var app = express()

      app.post('/upload-multi', multer({ storage: storage }).array('file', 2), function (req, res) {
        res.json({ success: true })
      })

      app.use(function (err, req, res, next) {
        res.status(400).json({ error: err.message || err.code })
      })

      server = app.listen(0, function () {
        port = server.address().port
        done()
      })
    })
  })

  afterEach(function (done) {
    server.close(function () {
      rimraf(uploadDir, done)
    })
  })

  it('should not leave a partially written file behind when the body ends mid-file', function (done) {
    this.timeout(5000)

    var boundary = 'MalformedBound' + Date.now()

    var partA =
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="slow.bin"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n' +
      'SLOW FILE CONTENT\r\n'

    var partBStart =
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="partial.bin"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n'

    var chunkB = Buffer.alloc(32 * 1024, 0x5a)

    var req = http.request({
      hostname: 'localhost',
      port: port,
      path: '/upload-multi',
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': Buffer.byteLength(partA) + Buffer.byteLength(partBStart) + (chunkB.length * 2)
      }
    }, function (res) {
      res.resume()
      res.on('end', function () {
        assert.strictEqual(res.statusCode, 400)

        setTimeout(function () {
          var files = fs.readdirSync(uploadDir)
          assert.strictEqual(files.length, 0, 'orphan files after malformed request: ' + files.join(', '))
          done()
        }, 500)
      })
    })

    req.on('error', function () {})

    req.write(partA)
    req.write(partBStart)
    req.write(chunkB)

    // let partial.bin reach the disk, then end the body without a closing boundary
    setTimeout(function () {
      req.end(chunkB)
    }, 100)
  })
})
