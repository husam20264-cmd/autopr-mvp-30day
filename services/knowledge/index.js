import { KnowledgeGraph } from './graph.js';
import { EmbeddingStore } from './embeddings.js';
import { KnowledgeIngestor } from './ingestor.js';
import { KnowledgeReasoner } from './reasoner.js';

let graphInstance;
let embeddingInstance;
let ingestorInstance;
let reasonerInstance;

export function getGraph() {
  if (!graphInstance) graphInstance = new KnowledgeGraph();
  return graphInstance;
}

export function getEmbeddings() {
  if (!embeddingInstance) embeddingInstance = new EmbeddingStore();
  return embeddingInstance;
}

export function getIngestor() {
  if (!ingestorInstance) ingestorInstance = new KnowledgeIngestor();
  return ingestorInstance;
}

export function getReasoner() {
  if (!reasonerInstance) reasonerInstance = new KnowledgeReasoner();
  return reasonerInstance;
}

export { KnowledgeGraph, EmbeddingStore, KnowledgeIngestor, KnowledgeReasoner };
