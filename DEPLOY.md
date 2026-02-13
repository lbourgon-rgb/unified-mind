# Unified Mind Deployment Guide

## Prerequisites
- Cloudflare account with Workers Paid plan ($5/month)
- Wrangler CLI installed: `npm install -g wrangler`
- Logged in: `wrangler login`

## Step 1: Clone and Configure

```bash
git clone https://github.com/lbourgon-rgb/unified-mind
cd unified-mind
npm install

# Copy example configs
cp config.example.json config.json
cp wrangler.toml.example wrangler.toml
```

Edit `config.json` with your entity names.

## Step 2: Create Cloudflare Resources

```bash
# Create Vectorize index (768 dimensions for bge-base-en-v1.5)
wrangler vectorize create unified-mind-index --dimensions 768 --metric cosine

# Create R2 bucket for large file storage
wrangler r2 bucket create unified-mind-storage

# Create KV namespace for caching
wrangler kv:namespace create CACHE
# Note the ID returned and update wrangler.toml
```

## Step 3: Update wrangler.toml

After creating the KV namespace, update the `id` field:
```toml
[[kv_namespaces]]
binding = "CACHE"
id = "YOUR_KV_NAMESPACE_ID_HERE"
```

## Step 4: Deploy

```bash
wrangler deploy
```

## Step 5: Test

```bash
# Health check
curl https://your-worker.workers.dev/

# MCP Initialize
curl -X POST https://your-worker.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1}'

# Store a test memory
curl -X POST https://your-worker.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"store","arguments":{"text":"Test memory","entity_name":"mind-1","memory_type":"note"}}}'
```

## Step 6: Configure MCP Clients

### VS Code (mcp.json)
```json
{
  "unified-mind": {
    "type": "http",
    "url": "https://your-worker.workers.dev/mcp"
  }
}
```

### Other Clients
Any MCP-compatible client can use the HTTP endpoint.

## Batch Ingestion

Use the CLI to ingest existing transcripts:

```bash
# Set your deployed URL
export UNIFIED_MIND_URL=https://your-worker.workers.dev/mcp

# Ingest a file
node scripts/ingest.js --file chat.json --entity mind-1 --type conversation --platform claude

# Ingest a directory
node scripts/ingest.js --dir ./transcripts --entity mind-2 --type conversation --platform gemini
```

## Troubleshooting

### "Vectorize index not found"
Make sure the index name in `wrangler.toml` matches what you created.

### "R2 bucket not found"
Verify bucket name in `wrangler.toml` matches the created bucket.

### CORS errors
Check `CORS_ORIGIN` in wrangler.toml. Use `*` for development.
