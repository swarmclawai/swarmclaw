import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { extractDocumentArtifact, loadTabularFile, normalizeInlineRows, writeStructuredTable } from './document-utils'

describe('document-utils', () => {
  it('extracts structured tables from JSON arrays', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-doc-utils-'))
    try {
      const jsonPath = path.join(tempDir, 'people.json')
      fs.writeFileSync(jsonPath, JSON.stringify([
        { name: 'Ada', score: 10 },
        { name: 'Grace', score: 9 },
      ], null, 2))

      const artifact = await extractDocumentArtifact(jsonPath)
      assert.equal(artifact.method, 'json')
      assert.equal(artifact.tables.length, 1)
      assert.deepEqual(artifact.tables[0].headers, ['name', 'score'])
      assert.equal(artifact.tables[0].rowCount, 2)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('normalizes inline rows and round-trips CSV output', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-doc-utils-'))
    try {
      const table = normalizeInlineRows([
        { city: 'London', population: 9 },
        { city: 'Paris', population: 2 },
      ])
      const csvPath = path.join(tempDir, 'cities.csv')
      const written = await writeStructuredTable(csvPath, table)
      const loaded = await loadTabularFile(csvPath)

      assert.equal(written.format, 'csv')
      assert.deepEqual(loaded.headers, ['city', 'population'])
      assert.equal(loaded.rowCount, 2)
      assert.equal(String(loaded.rows[0].city), 'London')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
