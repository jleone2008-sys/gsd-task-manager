-- Phase 6 — enable the pgvector extension for the RAG knowledge base.
-- Required by knowledge_chunks.embedding (vector(1536)) and by the
-- cosine-similarity index that backs semantic search.
--
-- Safe to re-run; the IF NOT EXISTS guards against double-creation.

create extension if not exists vector;
