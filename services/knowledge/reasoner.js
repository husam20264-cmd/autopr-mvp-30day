import { KnowledgeGraph } from './graph.js';
import { EmbeddingStore } from './embeddings.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class KnowledgeReasoner {
  constructor() {
    this.graph = new KnowledgeGraph();
    this.embeddings = new EmbeddingStore();
  }

  shouldFix(repoOwner, repoName, fixType, filePath) {
    const context = this.graph.getRepoContext(repoOwner, repoName);
    if (!context) return { should: true, confidence: 0.5, reason: 'New repo — no historical data' };

    let confidence = 0.5;

    if (context.frequentFiles.length > 0) {
      const knownFile = context.frequentFiles.find(f => filePath?.includes(f.path));
      if (knownFile) {
        confidence += knownFile.fixWeight * 0.3;
      }
    }

    if (context.recentPRs.length > 0) {
      const sameTypePRs = context.recentPRs.filter(p => p.properties?.fixType === fixType);
      if (sameTypePRs.length >= 2) {
        confidence += 0.2;
      }
    }

    const suggestion = this.graph.getFixSuggestions(repoOwner, repoName, filePath);
    if (suggestion.length > 0) {
      confidence += Math.min(0.2, suggestion[0].confidence * 0.2);
    }

    return {
      should: confidence >= 0.4,
      confidence: Math.min(1, confidence),
      reason: confidence >= 0.7 ? 'High confidence — similar fixes accepted before'
        : confidence >= 0.4 ? 'Medium confidence — some signals detected'
        : 'Low confidence — insufficient data',
      signals: {
        knownFile: context.frequentFiles.find(f => filePath?.includes(f.path)),
        sameTypePRs: context.recentPRs.filter(p => p.properties?.fixType === fixType).length,
        totalPRs: context.recentPRs.length,
        similarFixes: suggestion.slice(0, 3),
      },
    };
  }

  findRelatedCode(repoOwner, repoName, filePath, query) {
    const result = {
      relatedFiles: this.graph.getFilesRelatedTo(repoOwner, repoName, filePath),
      semanticResults: [],
    };

    if (query) {
      result.semanticResults = this.embeddings.search(query, { nodeType: 'file', limit: 5 });
    }

    return result;
  }

  predictFixStrategy(repoOwner, repoName, fixType, issueText) {
    const context = this.graph.getRepoContext(repoOwner, repoName);
    const similarEmbeddings = this.embeddings.search(issueText, { nodeType: 'issue', limit: 3 });

    const strategy = {
      fixType,
      approach: 'minimal',
      similarIssues: [],
      confidence: 0.5,
    };

    if (similarEmbeddings.length > 0) {
      strategy.similarIssues = similarEmbeddings.map(e => ({
        label: e.label,
        similarity: e.similarity,
      }));
      strategy.confidence += Math.min(0.3, similarEmbeddings[0].similarity * 0.3);
    }

    if (context?.frequentFiles.length > 0) {
      strategy.confidence += 0.1;
    }

    if (strategy.confidence >= 0.8) {
      strategy.approach = 'template';
    }

    return strategy;
  }

  getRepoProfile(repoOwner, repoName) {
    const context = this.graph.getRepoContext(repoOwner, repoName);
    if (!context) return null;

    return {
      health: {
        issuesCount: context.openIssues,
        recentFixes: context.recentPRs.length,
        frequentFiles: context.frequentFiles.length,
      },
      patterns: {
        topFixedFiles: context.frequentFiles,
        recentFixTypes: [...new Set(context.recentPRs.map(p => p.properties?.fixType).filter(Boolean))],
      },
      recommendations: context.frequentFiles.length > 0
        ? `Focus on ${context.frequentFiles[0].path} — highest fix frequency`
        : 'No fix history yet',
    };
  }
}
