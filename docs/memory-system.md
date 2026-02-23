# Agent Ember Memory System

The memory system provides persistent, searchable storage for agents with support for file references, image attachments, and linked memory graphs.

## Core Concepts

### Memory Entries

Each memory has:
- `id` - Unique identifier
- `agentId` - Optional scope (null = shared across all agents)
- `sessionId` - Optional session context
- `category` - Classification (note, fact, preference, project, identity, etc.)
- `title` - Short identifier
- `content` - Full content text
- `references` - Structured links to files, projects, URLs, etc.
- `image` - Optional compressed image attachment
- `linkedMemoryIds` - Links to other memories for graph traversal

### References

Memories can reference external resources:

```typescript
interface MemoryReference {
  type: 'project' | 'folder' | 'file' | 'task' | 'session' | 'url'
  path?: string           // File/folder path
  projectRoot?: string    // Project root directory
  projectName?: string    // Human-readable project name
  title?: string          // Display title (for sessions, tasks)
  note?: string           // Context about this reference
  exists?: boolean        // File/folder existence (checked at store time)
  timestamp: number       // When this reference was created
}
```

Usage:
```
memory_tool action=store key="Fixed bug" value="..." references=[{type:"file",path:"src/lib/server/x.ts",note:"The buggy function"}]
```

### Image Attachments

Images are automatically compressed (1024px max dimension, JPEG 75% quality) and stored in `data/memory-images/`:

```
memory_tool action=store key="Screenshot" value="..." imagePath="/path/to/screenshot.png"
```

### Memory Links & Graph Traversal

Memories can link to other memories, forming a graph:

```
memory_tool action=store key="Design decision" value="..." linkedMemoryIds=["abc123","def456"]
memory_tool action=link key="abc123" targetIds=["xyz789"]  # Add more links
memory_tool action=get key="abc123" depth=3               # Traverse linked memories
```

**Traversal Limits:**
- `maxDepth` - How many link hops to follow (default: 3, max: 12)
- `maxPerLookup` - Total memories to return (default: 20, max: 200)
- `maxLinkedExpansion` - Max linked memories to expand (default: 60, max: 1000)

## API

### memory_tool Actions

| Action | Description |
|--------|-------------|
| `store` | Create a new memory |
| `get` | Retrieve by ID, optionally with linked memories |
| `search` | Full-text + vector search |
| `list` | List all memories (scoped) |
| `delete` | Remove a memory |
| `link` | Add bidirectional links |
| `unlink` | Remove bidirectional links |

### Scope

Memories can be scoped:
- `auto` (default) - Shared + current agent's memories
- `shared` - Only cross-agent memories (agentId = null)
- `agent` - Only current agent's private memories

## Storage

- **Database:** `data/memory.db` (SQLite with FTS5 + vector embeddings)
- **Images:** `data/memory-images/` (compressed JPEGs)
- **Embeddings:** Generated lazily on first access (via configured embedding provider)

## Settings

Configure limits in Settings:

| Setting | Default | Max | Description |
|---------|---------|-----|-------------|
| `memoryReferenceDepth` | 3 | 12 | Max link hops to follow |
| `maxMemoriesPerLookup` | 20 | 200 | Max memories per search/get |
| `maxLinkedMemoriesExpanded` | 60 | 1000 | Max linked memories to expand |

## Migration

Legacy memories (`filePaths`, `imagePath` fields) are automatically migrated to the new schema on first run. No data loss.