#!/usr/bin/env node
'use strict'

const { runCli } = require('../src/cli/index')

runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code
}).catch((err) => {
  process.stderr.write(`${err.message || String(err)}\n`)
  process.exitCode = 1
})
