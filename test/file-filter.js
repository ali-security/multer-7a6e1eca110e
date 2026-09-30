/* eslint-env mocha */

var assert = require('assert')

var util = require('./_util')
var multer = require('../')
var FormData = require('form-data')

function withFilter (fileFilter) {
  return multer({ fileFilter: fileFilter })
}

function skipSpecificFile (req, file, cb) {
  cb(null, file.fieldname !== 'notme')
}

function reportFakeError (req, file, cb) {
  cb(new Error('Fake error'))
}

describe('File Filter', function () {
  it('should skip some files', function (done) {
    var form = new FormData()
    var upload = withFilter(skipSpecificFile)
    var parser = upload.fields([
      { name: 'notme', maxCount: 1 },
      { name: 'butme', maxCount: 1 }
    ])

    form.append('notme', util.file('tiny0.dat'))
    form.append('butme', util.file('tiny1.dat'))

    util.submitForm(parser, form, function (err, req) {
      assert.ifError(err)
      assert.strictEqual(req.files.notme, undefined)
      assert.strictEqual(req.files.butme[0].fieldname, 'butme')
      assert.strictEqual(req.files.butme[0].originalname, 'tiny1.dat')
      assert.strictEqual(req.files.butme[0].size, 7)
      assert.strictEqual(req.files.butme[0].buffer.length, 7)
      done()
    })
  })

  it('should report errors from fileFilter', function (done) {
    var form = new FormData()
    var upload = withFilter(reportFakeError)
    var parser = upload.single('test')

    form.append('test', util.file('tiny0.dat'))

    util.submitForm(parser, form, function (err, req) {
      assert.strictEqual(err.message, 'Fake error')
      done()
    })
  })

  it('should enforce fileSize limit with an async fileFilter (GHSA-qvfw-j98x-7q72)', function (done) {
    var form = new FormData()
    var upload = multer({
      fileFilter: function (req, file, cb) { setImmediate(function () { cb(null, true) }) },
      limits: { fileSize: 1024 }
    })
    var parser = upload.single('small0')

    // small0.dat is 1778 bytes, over the 1024 byte limit
    form.append('small0', util.file('small0.dat'))

    util.submitForm(parser, form, function (err, req) {
      assert.strictEqual(err.code, 'LIMIT_FILE_SIZE')
      assert.strictEqual(err.field, 'small0')
      done()
    })
  })

  it('should still skip oversized files rejected by an async fileFilter', function (done) {
    var form = new FormData()
    var upload = multer({
      fileFilter: function (req, file, cb) { setImmediate(function () { cb(null, false) }) },
      limits: { fileSize: 1024 }
    })
    var parser = upload.single('small0')

    form.append('small0', util.file('small0.dat'))

    util.submitForm(parser, form, function (err, req) {
      assert.ifError(err)
      assert.strictEqual(req.file, undefined)
      done()
    })
  })
})
