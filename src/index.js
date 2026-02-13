/**
 * Unified Mind MCP Worker
 * Multi-entity vector memory system
 * 
 * Uses Cloudflare Vectorize for semantic search
 * Uses R2 for large chunk storage
 * Enforces source attribution (Trill Boundary) on all retrieved memories
 */

// ============================================================================
// MCP Tool Definitions
// ============================================================================

const MCP_TOOLS = [
  {
    name: "search",
    description: `Search memories semantically. Returns memories with full source attribution.
    
    Args:
        query: Natural language search query
        entity: Optional - filter by entity namespace
        memory_type: Optional - filter by type (conversation, document, note, reflection, journal)
        source_platform: Optional - filter by platform
        limit: Number of results (default 10, max 20)
        min_score: Minimum similarity threshold (0-1, default 0.7)`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Semantic search query" },
        entity: { type: "string", description: "Entity namespace to search" },
        memory_type: { type: "string", enum: ["conversation", "document", "note", "reflection", "journal"] },
        source_platform: { type: "string", description: "Source platform filter" },
        limit: { type: "integer", default: 10, maximum: 20 },
        min_score: { type: "number", default: 0.7, minimum: 0, maximum: 1 }
      },
      required: ["query"]
    }
  },
  {
    name: "get_grounding_context",
    description: `Retrieve rich context for session grounding. Returns relevant memories with attribution headers.
    Use this at the START of a conversation to get up to speed.
    
    Args:
        topic: What you need context about (or "recent" for latest memories)
        entity: Whose memories to search (default: all)
        max_tokens: Approximate token budget (default 2000)`,
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic or 'recent' for latest" },
        entity: { type: "string", default: "all" },
        max_tokens: { type: "integer", default: 2000, maximum: 8000 }
      },
      required: ["topic"]
    }
  },
  {
    name: "ingest",
    description: `Ingest content into memory. Handles chunking, embedding, and storage.
    
    Args:
        content: Text to ingest
        entity_name: Who this belongs to (namespace)
        source_platform: Where this came from
        memory_type: Type classification
        metadata: Additional metadata (speaker, tags, timestamp)`,
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Text to ingest" },
        entity_name: { type: "string" },
        source_platform: { type: "string" },
        memory_type: { type: "string", enum: ["conversation", "document", "note", "reflection", "journal"] },
        metadata: { type: "object" }
      },
      required: ["content", "entity_name", "source_platform", "memory_type"]
    }
  },
  {
    name: "store",
    description: `Store a single memory directly (no chunking). For small atomic memories like notes.
    
    Args:
        text: Memory text (max 2000 chars)
        entity_name: Who this belongs to
        source_platform: Origin
        memory_type: Type
        metadata: Additional metadata`,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", maxLength: 2000 },
        entity_name: { type: "string" },
        source_platform: { type: "string" },
        memory_type: { type: "string" },
        metadata: { type: "object" }
      },
      required: ["text", "entity_name", "memory_type"]
    }
  },
  {
    name: "stats",
    description: `Get system statistics - storage usage, recent activity.`,
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

// ============================================================================
// Utility Functions
// ============================================================================

function generateId() {
  return 'mem_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

async function hashContent(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function chunkText(text, maxTokens = 400, overlap = 50) {
  const maxChars = maxTokens * 4;
  const overlapChars = overlap * 4;
  
  if (text.length <= maxChars) {
    return [text];
  }
  
  const chunks = [];
  let start = 0;
  
  while (start < text.length) {
    let end = start + maxChars;
    
    if (end < text.length) {
      const slice = text.slice(start, end);
      const lastBreak = Math.max(
        slice.lastIndexOf('\n\n'),
        slice.lastIndexOf('. '),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('! ')
      );
      if (lastBreak > maxChars * 0.5) {
        end = start + lastBreak + 1;
      }
    }
    
    chunks.push(text.slice(start, end).trim());
    start = end - overlapChars;
  }
  
  return chunks;
}

function formatAttribution(memory) {
  const entity = memory.metadata?.entity_name || 'unknown';
  const platform = memory.metadata?.source_platform || 'unknown';
  const timestamp = memory.metadata?.timestamp || 'unknown date';
  const type = memory.metadata?.memory_type || 'memory';
  
  return `[${type.toUpperCase()} from ${entity} | Source: ${platform} | ${timestamp}]
${memory.text || memory.metadata?.text_preview || '(content unavailable)'}
---`;
}

// ============================================================================
// MCP Protocol Handler
// ============================================================================

async function handleMCPRequest(request, env) {
  const body = await request.json();
  const { method, params, id } = body;
  
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'unified-mind',
            version: '1.0.0',
            description: 'Multi-entity vector memory with source attribution'
          }
        }
      };
      
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: MCP_TOOLS }
      };
      
    case 'tools/call':
      const { name, arguments: args } = params;
      try {
        const result = await executeTool(name, args || {}, env);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        };
      } catch (error) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: error.message }
        };
      }
      
    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown method: ${method}` }
      };
  }
}

// ============================================================================
// Tool Execution
// ============================================================================

async function executeTool(name, args, env) {
  switch (name) {
    case 'search':
      return await toolSearch(args, env);
    case 'get_grounding_context':
      return await toolGetGroundingContext(args, env);
    case 'ingest':
      return await toolIngest(args, env);
    case 'store':
      return await toolStore(args, env);
    case 'stats':
      return await toolStats(env);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================================
// Tool: Search
// ============================================================================

async function toolSearch(args, env) {
  const { query, entity, memory_type, source_platform, limit = 10, min_score = 0.7 } = args;
  
  const embedding = await generateEmbedding(query, env);
  
  const filter = {};
  if (entity && entity !== 'all') {
    filter.entity_name = entity;
  }
  if (memory_type) {
    filter.memory_type = memory_type;
  }
  if (source_platform) {
    filter.source_platform = source_platform;
  }
  
  const queryOptions = {
    topK: Math.min(limit, 20),
    returnValues: false,
    returnMetadata: 'all'
  };
  
  if (Object.keys(filter).length > 0) {
    queryOptions.filter = filter;
  }
  
  const results = await env.VECTORIZE.query(embedding, queryOptions);
  
  const memories = results.matches
    .filter(m => m.score >= min_score)
    .map(m => ({
      id: m.id,
      score: m.score,
      text: m.metadata?.text_preview,
      metadata: m.metadata,
      formatted: formatAttribution({ metadata: m.metadata, text: m.metadata?.text_preview })
    }));
  
  return {
    query,
    count: memories.length,
    memories
  };
}

// ============================================================================
// Tool: Get Grounding Context
// ============================================================================

async function toolGetGroundingContext(args, env) {
  const { topic, entity = 'all', max_tokens = 2000 } = args;
  
  let searchQuery = topic;
  
  if (topic.toLowerCase() === 'recent') {
    searchQuery = 'recent conversation important memory significant moment';
  }
  
  const searchResult = await toolSearch({
    query: searchQuery,
    entity,
    limit: 20,
    min_score: 0.5
  }, env);
  
  let context = `## Grounding Context\n`;
  context += `Query: "${topic}" | Entity filter: ${entity}\n\n`;
  
  let currentTokens = estimateTokens(context);
  const includedMemories = [];
  
  for (const memory of searchResult.memories) {
    const memoryText = memory.formatted;
    const memoryTokens = estimateTokens(memoryText);
    
    if (currentTokens + memoryTokens <= max_tokens) {
      context += memoryText + '\n';
      currentTokens += memoryTokens;
      includedMemories.push(memory.id);
    } else {
      break;
    }
  }
  
  return {
    context,
    token_estimate: currentTokens,
    memories_included: includedMemories.length,
    total_available: searchResult.count
  };
}

// ============================================================================
// Tool: Ingest
// ============================================================================

async function toolIngest(args, env) {
  const { content, entity_name, source_platform, memory_type, metadata = {} } = args;
  
  const maxChunkTokens = parseInt(env.MAX_CHUNK_TOKENS) || 400;
  const chunkOverlap = parseInt(env.CHUNK_OVERLAP) || 50;
  const chunks = chunkText(content, maxChunkTokens, chunkOverlap);
  
  const results = [];
  const timestamp = new Date().toISOString();
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const hash = await hashContent(chunk);
    const id = generateId();
    
    const embedding = await generateEmbedding(chunk, env);
    
    const vectorMetadata = {
      entity_name,
      source_platform,
      memory_type,
      timestamp: metadata.timestamp || timestamp,
      text_preview: chunk.slice(0, 500),
      chunk_hash: hash,
      chunk_index: i,
      total_chunks: chunks.length,
      ingested_at: timestamp,
      ...metadata
    };
    
    if (chunk.length > 500) {
      const r2Key = `chunks/${hash}.json`;
      await env.R2.put(r2Key, JSON.stringify({
        hash,
        text: chunk,
        metadata: vectorMetadata
      }));
      vectorMetadata.r2_key = r2Key;
    }
    
    await env.VECTORIZE.upsert([{
      id,
      values: embedding,
      namespace: entity_name,
      metadata: vectorMetadata
    }]);
    
    results.push({ id, hash, chunk_index: i });
  }
  
  return {
    success: true,
    entity: entity_name,
    chunks_created: results.length,
    memory_ids: results.map(r => r.id)
  };
}

// ============================================================================
// Tool: Store
// ============================================================================

async function toolStore(args, env) {
  const { text, entity_name, source_platform = 'direct', memory_type, metadata = {} } = args;
  
  const id = generateId();
  const timestamp = new Date().toISOString();
  const hash = await hashContent(text);
  
  const embedding = await generateEmbedding(text, env);
  
  const vectorMetadata = {
    entity_name,
    source_platform,
    memory_type,
    timestamp: metadata.timestamp || timestamp,
    text_preview: text.slice(0, 500),
    chunk_hash: hash,
    ingested_at: timestamp,
    ...metadata
  };
  
  await env.VECTORIZE.upsert([{
    id,
    values: embedding,
    namespace: entity_name,
    metadata: vectorMetadata
  }]);
  
  return {
    success: true,
    memory_id: id,
    entity: entity_name,
    type: memory_type
  };
}

// ============================================================================
// Tool: Stats
// ============================================================================

async function toolStats(env) {
  let stats = {};
  
  try {
    const cached = await env.CACHE.get('unified-mind:stats', 'json');
    if (cached) {
      stats = cached;
    }
  } catch (e) {
    // KV might not exist yet
  }
  
  return {
    index: 'unified-mind-index',
    last_updated: stats.last_updated || 'unknown',
    vector_count_estimate: stats.vector_count || 'unknown',
    storage: {
      r2_bucket: 'unified-mind-storage',
      kv_namespace: 'unified-mind-cache'
    }
  };
}

// ============================================================================
// Embedding Generation
// ============================================================================

async function generateEmbedding(text, env) {
  const response = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: [text]
  });
  
  return response.data[0];
}

// ============================================================================
// Request Handler
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    const corsHeaders = {
      'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'unified-mind',
        version: '1.0.0',
        timestamp: new Date().toISOString()
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    if (url.pathname === '/mcp' && request.method === 'POST') {
      try {
        const result = await handleMCPRequest(request, env);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: error.message }
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }
    
    return new Response(JSON.stringify({
      error: 'Not Found',
      hint: 'Use POST /mcp for MCP protocol'
    }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};
