import { describe, it, expect } from 'vitest'
import {
  BUILTIN_MCP_SERVERS,
  getBuiltinMcpServer,
} from '../../../../src/multi/agents/mcp/builtin.js'

describe('BUILTIN_MCP_SERVERS catalog', () => {
  it('contains exactly 8 entries', () => {
    expect(BUILTIN_MCP_SERVERS).toHaveLength(8)
  })

  it('getBuiltinMcpServer("gcal") returns the gcal entry', () => {
    const s = getBuiltinMcpServer('gcal')
    expect(s).toBeDefined()
    expect(s?.name).toBe('Google Calendar')
  })

  it('getBuiltinMcpServer for unknown id returns undefined', () => {
    expect(getBuiltinMcpServer('nonexistent')).toBeUndefined()
  })

  it('all entries with oauth have a non-empty envMap', () => {
    for (const s of BUILTIN_MCP_SERVERS) {
      if (s.oauth) {
        expect(Object.keys(s.oauth.envMap).length).toBeGreaterThan(0)
      }
    }
  })

  it('all entries have unique ids', () => {
    const ids = BUILTIN_MCP_SERVERS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('all ids match [a-z0-9_-]+', () => {
    for (const s of BUILTIN_MCP_SERVERS) {
      expect(s.id).toMatch(/^[a-z0-9_-]+$/)
    }
  })

  it('stdio entries define a command', () => {
    for (const s of BUILTIN_MCP_SERVERS) {
      if (s.transport === 'stdio') {
        expect(s.command, `entry ${s.id} missing command`).toBeDefined()
        expect(typeof s.command).toBe('string')
      }
    }
  })

  it('legacy core ids are preserved', () => {
    for (const id of ['gcal', 'gmail', 'gdrive', 'notion', 'playwright', 'fs']) {
      expect(getBuiltinMcpServer(id), `missing legacy id ${id}`).toBeDefined()
    }
  })
})
