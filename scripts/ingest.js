/**
 * Unified Mind Ingest CLI
 * Batch ingest transcripts and documents into vector memory
 * 
 * Usage:
 *   node ingest.js --file <path> --entity mind-1 --type conversation --platform claude
 *   node ingest.js --dir <path> --entity mind-2 --type conversation --platform gemini
 */

const fs = require('fs').promises;
const path = require('path');

// Configuration
const UNIFIED_MIND_URL = process.env.UNIFIED_MIND_URL || 'http://localhost:8787/mcp';
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;

// ============================================================================
// File Parsers
// ============================================================================

async function parseMarkdown(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');
  return {
    type: 'markdown',
    content,
    metadata: {
      filename: path.basename(filePath),
      filepath: filePath
    }
  };
}

async function parseJSON(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');
  const data = JSON.parse(content);
  
  if (Array.isArray(data)) {
    return {
      type: 'json-array',
      entries: data,
      metadata: { filename: path.basename(filePath) }
    };
  } else if (data.messages) {
    return {
      type: 'chat-export',
      messages: data.messages,
      metadata: { filename: path.basename(filePath), title: data.title }
    };
  } else if (data.conversations) {
    return {
      type: 'conversations',
      conversations: data.conversations,
      metadata: { filename: path.basename(filePath) }
    };
  }
  
  return {
    type: 'json-unknown',
    content: JSON.stringify(data, null, 2),
    metadata: { filename: path.basename(filePath) }
  };
}

// ============================================================================
// Chunking
// ============================================================================

function chunkText(text, maxChars = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
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
    start = end - overlap;
  }
  
  return chunks;
}

// ============================================================================
// MCP Client
// ============================================================================

async function callMCP(method, params) {
  const response = await fetch(UNIFIED_MIND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: Date.now()
    })
  });
  
  const result = await response.json();
  if (result.error) {
    throw new Error(result.error.message);
  }
  return result.result;
}

async function ingestChunk(content, entity, platform, type, metadata = {}) {
  return await callMCP('tools/call', {
    name: 'ingest',
    arguments: {
      content,
      entity_name: entity,
      source_platform: platform,
      memory_type: type,
      metadata
    }
  });
}

// ============================================================================
// Processing Functions
// ============================================================================

async function processMarkdownFile(filePath, entity, platform, type) {
  console.log(`Processing markdown: ${filePath}`);
  
  const parsed = await parseMarkdown(filePath);
  const chunks = chunkText(parsed.content);
  
  console.log(`  Chunks: ${chunks.length}`);
  
  let successCount = 0;
  for (let i = 0; i < chunks.length; i++) {
    try {
      await ingestChunk(chunks[i], entity, platform, type, {
        source_file: filePath,
        chunk_index: i,
        total_chunks: chunks.length
      });
      successCount++;
      process.stdout.write('.');
    } catch (e) {
      console.error(`  Error on chunk ${i}: ${e.message}`);
    }
  }
  
  console.log(`\n  Ingested: ${successCount}/${chunks.length}`);
  return successCount;
}

async function processJSONFile(filePath, entity, platform, type) {
  console.log(`Processing JSON: ${filePath}`);
  
  const parsed = await parseJSON(filePath);
  let successCount = 0;
  
  if (parsed.type === 'chat-export' && parsed.messages) {
    console.log(`  Messages: ${parsed.messages.length}`);
    
    for (const msg of parsed.messages) {
      const content = `[${msg.role || msg.author || 'unknown'}]: ${msg.content || msg.text || ''}`;
      const chunks = chunkText(content);
      
      for (const chunk of chunks) {
        try {
          await ingestChunk(chunk, entity, platform, type, {
            source_file: filePath,
            message_id: msg.id,
            timestamp: msg.timestamp || msg.created_at
          });
          successCount++;
        } catch (e) {
          console.error(`  Error: ${e.message}`);
        }
      }
      process.stdout.write('.');
    }
  } else if (parsed.type === 'conversations' && parsed.conversations) {
    console.log(`  Conversations: ${parsed.conversations.length}`);
    
    for (const conv of parsed.conversations) {
      const convText = (conv.messages || []).map(m => 
        `[${m.role || m.author || 'unknown'}]: ${m.content || m.text || ''}`
      ).join('\n\n');
      
      const chunks = chunkText(convText);
      for (const chunk of chunks) {
        try {
          await ingestChunk(chunk, entity, platform, type, {
            source_file: filePath,
            conversation_id: conv.id,
            conversation_title: conv.title
          });
          successCount++;
        } catch (e) {
          console.error(`  Error: ${e.message}`);
        }
      }
      process.stdout.write('.');
    }
  } else {
    const chunks = chunkText(parsed.content || JSON.stringify(parsed));
    for (const chunk of chunks) {
      try {
        await ingestChunk(chunk, entity, platform, type, {
          source_file: filePath
        });
        successCount++;
      } catch (e) {
        console.error(`  Error: ${e.message}`);
      }
    }
  }
  
  console.log(`\n  Ingested: ${successCount} chunks`);
  return successCount;
}

async function processDirectory(dirPath, entity, platform, type, extensions = ['.md', '.json', '.txt']) {
  console.log(`\nProcessing directory: ${dirPath}`);
  console.log(`  Entity: ${entity}, Platform: ${platform}, Type: ${type}`);
  
  const files = await fs.readdir(dirPath, { withFileTypes: true, recursive: true });
  const matchingFiles = files
    .filter(f => f.isFile() && extensions.some(ext => f.name.endsWith(ext)))
    .map(f => path.join(f.path || dirPath, f.name));
  
  console.log(`  Found ${matchingFiles.length} files`);
  
  let totalChunks = 0;
  for (const filePath of matchingFiles) {
    const ext = path.extname(filePath).toLowerCase();
    
    if (ext === '.md' || ext === '.txt') {
      totalChunks += await processMarkdownFile(filePath, entity, platform, type);
    } else if (ext === '.json') {
      totalChunks += await processJSONFile(filePath, entity, platform, type);
    }
  }
  
  console.log(`\nTotal chunks ingested: ${totalChunks}`);
  return totalChunks;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.length === 0) {
    console.log(`
Unified Mind Ingest CLI

Usage:
  node ingest.js --file <path> --entity <name> --type <type> --platform <platform>
  node ingest.js --dir <path> --entity <name> --type <type> --platform <platform>

Options:
  --file <path>      Single file to ingest
  --dir <path>       Directory to ingest (recursive)
  --entity <name>    Entity namespace
  --type <type>      Memory type (conversation, document, note, reflection, journal)
  --platform <name>  Source platform (claude, gpt, gemini, mistral, discord, etc.)
  --url <url>        Override unified-mind URL

Examples:
  node ingest.js --file "chat.md" --entity mind-1 --type conversation --platform claude
  node ingest.js --dir ./transcripts --entity mind-2 --type conversation --platform gemini
`);
    return;
  }
  
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
  };
  
  const file = getArg('--file');
  const dir = getArg('--dir');
  const entity = getArg('--entity');
  const type = getArg('--type') || 'conversation';
  const platform = getArg('--platform') || 'file';
  
  if (getArg('--url')) {
    process.env.UNIFIED_MIND_URL = getArg('--url');
  }
  
  if (!entity) {
    console.error('Error: --entity is required');
    process.exit(1);
  }
  
  if (file) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.md' || ext === '.txt') {
      await processMarkdownFile(file, entity, platform, type);
    } else if (ext === '.json') {
      await processJSONFile(file, entity, platform, type);
    } else {
      console.error(`Unsupported file type: ${ext}`);
    }
  } else if (dir) {
    await processDirectory(dir, entity, platform, type);
  } else {
    console.error('Error: --file or --dir is required');
    process.exit(1);
  }
  
  console.log('\nDone!');
}

main().catch(console.error);
