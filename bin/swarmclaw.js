#!/usr/bin/env node
'use strict'

const { runCli } = require('../src/cli/index')

runCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode
})
