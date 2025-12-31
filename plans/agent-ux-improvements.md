# AI Agent UX Improvements Implementation Plan

## 🎯 Overview

This plan outlines comprehensive improvements to transform the codegraph library from a developer tool into an AI agent-first platform for intelligent code review. The goal is to make PR analysis and code understanding seamless for AI agents while maintaining human usability.

## 📋 Prerequisites

Before starting, ensure you have:
- [ ] Node.js 18+
- [ ] TypeScript knowledge
- [ ] Understanding of the current codebase (read README.md)
- [ ] Familiarity with Tree-sitter AST parsing
- [ ] Basic understanding of AI/LLM integration patterns

## 🏗️ Architecture Overview

```
Current Architecture:
CLI → Core Analysis → Human-Readable Output

Target Architecture:
Agent Interface → Smart Analysis → Structured Output → Integration Layer
```

## 📚 Phase 1: Foundation - Agent-First Data Structures (Week 1-2)

### 1.1 Create Agent-Optimized Types

**File**: `src/agent/types.ts`

```typescript
// Create comprehensive type definitions for agent interactions
export interface AgentReviewContext {
  changeProfile: ChangeProfile;
  concerns: Concern[];
  reviewContext: ReviewContextData;
  followUpQuestions: string[];
  suggestedReviewFlow: string[];
}

export interface ChangeProfile {
  type: "feature" | "bugfix" | "refactor" | "hotfix" | "breaking";
  scope: "frontend" | "backend" | "fullstack" | "infrastructure";
  complexity: "trivial" | "simple" | "moderate" | "complex";
  riskLevel: "low" | "medium" | "high" | "critical";
}

export interface Concern {
  category: "security" | "performance" | "breaking-change" | "testing" | "architecture";
  severity: number; // 0-1
  title: string;
  description: string;
  affectedFiles: string[];
  suggestedAction: string;
  evidence: Evidence;
}

export interface Evidence {
  type: "code-pattern" | "dependency-change" | "api-signature" | "data-flow";
  details: any;
  confidence: number; // 0-1
}
```

**Tasks**:
- [ ] Create `src/agent/types.ts` with all interface definitions
- [ ] Add JSDoc comments for all interfaces
- [ ] Create example JSON files in `tests/samples/agent/` 
- [ ] Write unit tests for type validation

**Acceptance Criteria**:
- All types are properly exported
- Types include confidence scores and evidence
- Complete JSDoc documentation
- Type validation tests pass

### 1.2 Enhanced Impact Analysis Types

**File**: `src/impact/agentTypes.ts`

```typescript
// Extend existing impact types for agent consumption
export interface AgentImpactReport extends ImpactReport {
  reasoning: ReasoningChain;
  riskAssessment: RiskAssessment;
  testingSuggestions: TestingSuggestion[];
  reviewGuidance: ReviewGuidance;
}

export interface ReasoningChain {
  steps: Array<{
    analysis: string;
    evidence: string[];
    confidence: number;
  }>;
  conclusion: string;
  alternatives: string[];
}
```

**Tasks**:
- [ ] Extend existing impact types in `src/impact/types.ts`
- [ ] Create agent-specific impact interfaces
- [ ] Add reasoning chain structures
- [ ] Update existing impact analyzer to support new types

## 📊 Phase 2: Smart Context Assembly (Week 3-4)

### 2.1 Semantic Context Gatherer

**File**: `src/agent/contextGatherer.ts`

```typescript
export class SmartContextGatherer {
  constructor(private index: ProjectIndex) {}

  async gatherReviewContext(
    changes: FileChange[], 
    options: ContextOptions = {}
  ): Promise<ReviewContext> {
    const [dependencies, semantic, risk, business, testing] = await Promise.all([
      this.analyzeDependencies(changes),
      this.gatherSemanticContext(changes),
      this.assessRiskContext(changes),
      this.inferBusinessContext(changes),
      this.analyzeTestImpact(changes)
    ]);

    return this.synthesizeContext({ dependencies, semantic, risk, business, testing }, options);
  }

  private async gatherSemanticContext(changes: FileChange[]): Promise<SemanticContext> {
    // Analyze code patterns, coupling, architectural changes
  }

  private async assessRiskContext(changes: FileChange[]): Promise<RiskContext> {
    // Security, performance, data flow analysis
  }
}
```

**Tasks**:
- [ ] Create `SmartContextGatherer` class
- [ ] Implement semantic pattern detection using existing Tree-sitter queries
- [ ] Add security pattern scanning (see examples in existing impact analyzer)
- [ ] Create performance impact analysis
- [ ] Add architectural change detection
- [ ] Write comprehensive tests

**Key Implementation Notes**:
- Reuse existing `findReferences` and `goToDefinition` functions
- Extend current Tree-sitter query system in `src/languages/`
- Build on existing impact analysis in `src/impact/analyzer.ts`

### 2.2 Risk Assessment Engine

**File**: `src/agent/riskAssessment.ts`

```typescript
export class RiskAssessmentEngine {
  private securityPatterns = [
    /exec\(|eval\(|spawn\(/,
    /password|secret|key.*=/,
    /sql.*\+|\$\{.*\}/,
    /innerHTML|outerHTML/
  ];

  async assessRisk(changes: FileChange[], context: ProjectContext): Promise<RiskAssessment> {
    const risks = await Promise.all([
      this.scanSecurityRisks(changes),
      this.analyzePerformanceRisks(changes),
      this.checkBreakingChanges(changes, context),
      this.assessDataIntegrityRisks(changes)
    ]);

    return this.synthesizeRiskAssessment(risks);
  }

  private async scanSecurityRisks(changes: FileChange[]): Promise<SecurityRisk[]> {
    // Implementation using existing textGrep functionality
  }
}
```

**Tasks**:
- [ ] Create risk assessment patterns database
- [ ] Implement security scanning using existing `textGrep` function
- [ ] Add breaking change detection using symbol analysis
- [ ] Create performance risk heuristics
- [ ] Add data integrity risk detection
- [ ] Write risk synthesis algorithm

## 🤖 Phase 3: Conversational Interface (Week 5-6)

### 3.1 Conversational Agent Core

**File**: `src/agent/conversationalAgent.ts`

```typescript
export class ConversationalCodeAnalysis {
  private context: AnalysisContext;
  private memory: ConversationMemory = new Map();

  async startConversation(prData: PRData): Promise<ConversationState> {
    this.context = await this.buildInitialContext(prData);
    
    const summary = await this.generateInitialSummary();
    const questions = this.generateSuggestedQuestions();
    
    return {
      summary,
      suggestedQuestions: questions,
      conversationId: this.generateConversationId(),
      context: this.context
    };
  }

  async ask(question: string, conversationId: string): Promise<AnalysisResponse> {
    const intent = await this.parseIntent(question);
    const previousContext = this.memory.get(conversationId);
    
    const response = await this.processIntent(intent, previousContext);
    
    // Update conversation memory
    this.memory.set(conversationId, {
      ...previousContext,
      lastQuestion: question,
      lastResponse: response,
      questionCount: (previousContext?.questionCount || 0) + 1
    });
    
    return response;
  }

  private async parseIntent(question: string): Promise<Intent> {
    const patterns = {
      riskAssessment: /risk|danger|problem|issue|concern|security|vulnerability/i,
      impactTrace: /impact|affect|downstream|upstream|dependency|connected/i,
      testGuidance: /test|coverage|regression|validation|qa/i,
      explainChange: /why|what|how|explain|purpose|reason/i,
      reviewGuidance: /review|check|look|focus|priority/i
    };

    // Simple pattern matching - can be enhanced with NLP later
    for (const [type, pattern] of Object.entries(patterns)) {
      if (pattern.test(question)) {
        return { type: type as IntentType, parameters: this.extractParameters(question, type) };
      }
    }

    return { type: "general", parameters: {} };
  }
}
```

**Tasks**:
- [ ] Create conversational agent class
- [ ] Implement intent parsing using pattern matching
- [ ] Add conversation memory management
- [ ] Create response generation for each intent type
- [ ] Build context accumulation across questions
- [ ] Add conversation state management
- [ ] Write conversation flow tests

### 3.2 Intent Processing Engine

**File**: `src/agent/intentProcessor.ts`

```typescript
export class IntentProcessor {
  constructor(
    private contextGatherer: SmartContextGatherer,
    private riskEngine: RiskAssessmentEngine,
    private index: ProjectIndex
  ) {}

  async processRiskAssessment(parameters: any, context: AnalysisContext): Promise<RiskAnalysisResponse> {
    const risks = await this.riskEngine.assessRisk(context.changes, context.projectContext);
    
    return {
      type: "risk-analysis",
      risks: risks.concerns,
      severity: risks.overallSeverity,
      recommendations: risks.recommendations,
      followUpQuestions: this.generateRiskFollowUps(risks)
    };
  }

  async processImpactTrace(parameters: any, context: AnalysisContext): Promise<ImpactTraceResponse> {
    const impact = await analyzeImpact(this.index, context.changedSymbols, context.changes);
    
    return {
      type: "impact-trace",
      impactedFiles: impact.slice(0, 10), // Top 10 most impacted
      impactChain: this.buildImpactChain(impact),
      recommendations: this.generateImpactRecommendations(impact),
      followUpQuestions: ["Which specific components should I focus on?", "What are the testing implications?"]
    };
  }
}
```

**Tasks**:
- [ ] Create intent processor for each intent type
- [ ] Implement response generation strategies
- [ ] Add follow-up question generation
- [ ] Create response formatting utilities
- [ ] Write processor tests for each intent

## 💾 Phase 4: Agent Memory and Learning (Week 7)

### 4.1 Project Memory System

**File**: `src/agent/memory.ts`

```typescript
export class ProjectMemoryManager {
  private memoryPath: string;
  private memory: ProjectMemory;

  constructor(projectRoot: string) {
    this.memoryPath = path.join(projectRoot, '.codegraph-cache', 'agent-memory.json');
    this.memory = this.loadMemory();
  }

  async learnFromReview(review: CompletedReview): Promise<void> {
    // Extract patterns
    const patterns = await this.extractPatterns(review);
    
    // Update project profile
    await this.updateProjectProfile(patterns);
    
    // Update review history
    this.memory.reviewHistory.push({
      timestamp: Date.now(),
      changes: review.changes,
      issues: review.foundIssues,
      outcome: review.outcome,
      lessons: patterns.lessons
    });

    // Limit history size
    if (this.memory.reviewHistory.length > 100) {
      this.memory.reviewHistory = this.memory.reviewHistory.slice(-100);
    }

    await this.saveMemory();
  }

  async suggestBasedOnHistory(currentChanges: FileChange[]): Promise<HistoricalSuggestion[]> {
    const similarChanges = await this.findSimilarChanges(currentChanges);
    return this.generateSuggestionsFromHistory(similarChanges);
  }

  private async extractPatterns(review: CompletedReview): Promise<LearnedPatterns> {
    return {
      commonIssues: this.identifyCommonIssues(review),
      successfulPatterns: this.identifySuccessfulPatterns(review),
      lessons: this.extractLessons(review)
    };
  }
}
```

**Tasks**:
- [ ] Create project memory data structures
- [ ] Implement memory persistence (JSON files)
- [ ] Add pattern extraction from completed reviews
- [ ] Create similarity detection algorithms
- [ ] Implement suggestion generation from history
- [ ] Add memory cleanup and optimization
- [ ] Write memory management tests

### 4.2 Learning System

**File**: `src/agent/learningSystem.ts`

```typescript
export class LearningSystem {
  constructor(
    private memoryManager: ProjectMemoryManager,
    private index: ProjectIndex
  ) {}

  async analyzeWithHistory(
    changes: FileChange[], 
    options: AnalysisOptions = {}
  ): Promise<EnhancedAnalysis> {
    const [currentAnalysis, historicalSuggestions] = await Promise.all([
      this.performCurrentAnalysis(changes, options),
      this.memoryManager.suggestBasedOnHistory(changes)
    ]);

    return this.combineAnalysisWithHistory(currentAnalysis, historicalSuggestions);
  }

  async updateLearning(feedback: ReviewFeedback): Promise<void> {
    await this.memoryManager.processFeedback(feedback);
    
    // Update confidence scores based on feedback
    await this.updateConfidenceModels(feedback);
  }
}
```

**Tasks**:
- [ ] Create learning system architecture
- [ ] Implement feedback processing
- [ ] Add confidence score adjustments
- [ ] Create historical analysis integration
- [ ] Write learning system tests

## ⚡ Phase 5: Performance and Caching (Week 8)

### 5.1 Insight Cache System

**File**: `src/agent/insightCache.ts`

```typescript
export class InsightCache {
  private cache: Map<string, CachedInsight> = new Map();
  private diskCache: string;

  constructor(projectRoot: string) {
    this.diskCache = path.join(projectRoot, '.codegraph-cache', 'insights-v1');
  }

  async precomputeInsights(index: ProjectIndex): Promise<ProjectInsights> {
    const insights = await Promise.all([
      this.identifyCodeHotspots(index),
      this.buildOwnershipMap(index),
      this.identifyRiskAreas(index),
      this.buildTestCoverageMap(index),
      this.identifyArchitecturalBoundaries(index)
    ]);

    const projectInsights = this.synthesizeInsights(insights);
    await this.persistInsights(projectInsights);
    
    return projectInsights;
  }

  async getInstantInsights(changes: FileChange[]): Promise<InstantInsights> {
    const cacheKey = this.generateCacheKey(changes);
    
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!.insights;
    }

    const insights = await this.computeInsights(changes);
    this.cache.set(cacheKey, { 
      insights, 
      timestamp: Date.now(),
      hits: 1 
    });

    return insights;
  }

  private async identifyCodeHotspots(index: ProjectIndex): Promise<CodeHotspot[]> {
    // Use existing graph analysis to find highly connected nodes
    const fanInCounts = new Map<string, number>();
    
    for (const edge of index.graph.edges) {
      if (edge.to.type === "file") {
        fanInCounts.set(edge.to.path, (fanInCounts.get(edge.to.path) || 0) + 1);
      }
    }

    return Array.from(fanInCounts.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20)
      .map(([file, count]) => ({
        file,
        fanIn: count,
        riskScore: this.calculateHotspotRisk(file, count, index)
      }));
  }
}
```

**Tasks**:
- [ ] Create insight caching system
- [ ] Implement precomputation during indexing
- [ ] Add cache invalidation strategies
- [ ] Create hotspot identification algorithms
- [ ] Build ownership mapping (git blame integration)
- [ ] Add test coverage analysis
- [ ] Write cache performance tests

### 5.2 Fast Query Interface

**File**: `src/agent/fastQueries.ts`

```typescript
export class FastQueryInterface {
  constructor(
    private insightCache: InsightCache,
    private index: ProjectIndex
  ) {}

  async quickRiskCheck(files: string[]): Promise<QuickRiskResult> {
    const cached = await this.insightCache.getFileRiskScores(files);
    
    return {
      overallRisk: this.calculateOverallRisk(cached),
      riskByFile: cached,
      topConcerns: this.getTopConcerns(cached),
      responseTime: "< 100ms"
    };
  }

  async suggestReviewers(changes: FileChange[]): Promise<ReviewerSuggestion[]> {
    const ownership = await this.insightCache.getOwnershipData(
      changes.map(c => c.path)
    );

    return this.rankReviewers(ownership, changes);
  }

  async getRelatedFiles(file: string, depth: number = 2): Promise<RelatedFile[]> {
    // Use precomputed dependency graph for instant results
    const cached = await this.insightCache.getDependencyNeighbors(file, depth);
    
    return cached.map(neighbor => ({
      file: neighbor.file,
      relationship: neighbor.relationship,
      importance: neighbor.importance,
      distance: neighbor.distance
    }));
  }
}
```

**Tasks**:
- [ ] Create fast query interface
- [ ] Implement sub-100ms query responses
- [ ] Add reviewer suggestion algorithms
- [ ] Create related file discovery
- [ ] Build quick risk assessment
- [ ] Write performance benchmarks

## 🔌 Phase 6: Integration Layer (Week 9-10)

### 6.1 GitHub Integration

**File**: `src/integrations/github.ts`

```typescript
export class GitHubReviewBot {
  constructor(
    private agent: ConversationalCodeAnalysis,
    private fastQueries: FastQueryInterface
  ) {}

  async handlePREvent(pr: PullRequest, event: PREvent): Promise<void> {
    switch (event.type) {
      case "opened":
        await this.handlePROpened(pr);
        break;
      case "updated":
        await this.handlePRUpdated(pr);
        break;
      case "review-requested":
        await this.handleReviewRequested(pr, event.reviewer);
        break;
    }
  }

  private async handlePROpened(pr: PullRequest): Promise<void> {
    const quickAnalysis = await this.fastQueries.quickRiskCheck(pr.changedFiles);
    
    if (quickAnalysis.overallRisk > 0.7) {
      await this.postRiskWarning(pr, quickAnalysis);
      const suggestedReviewers = await this.fastQueries.suggestReviewers(pr.changes);
      await this.requestAdditionalReview(pr, suggestedReviewers);
    }

    const conversation = await this.agent.startConversation(pr);
    await this.postSummaryComment(pr, conversation);
  }

  private async postSummaryComment(pr: PullRequest, conversation: ConversationState): Promise<void> {
    const comment = this.formatForGitHub(conversation.summary);
    await pr.createComment(comment);
  }

  private formatForGitHub(summary: ReviewSummary): string {
    return `
## 🤖 AI Code Review Summary

**Change Type**: ${summary.changeProfile.type} (${summary.changeProfile.complexity})  
**Risk Level**: ${this.formatRiskLevel(summary.changeProfile.riskLevel)}

### Key Findings
${summary.concerns.map(c => `- **${c.category}**: ${c.title}`).join('\n')}

### Suggested Focus Areas
${summary.suggestedReviewFlow.map(step => `1. ${step}`).join('\n')}

---
*Ask me questions about this PR by mentioning @codegraph-bot*
    `;
  }
}
```

**Tasks**:
- [ ] Create GitHub webhook handlers
- [ ] Implement PR event processing
- [ ] Add comment formatting utilities
- [ ] Create reviewer suggestion system
- [ ] Build risk warning notifications
- [ ] Add interactive comment handling
- [ ] Write GitHub integration tests

### 6.2 VS Code Extension Interface

**File**: `src/integrations/vscode.ts`

```typescript
export class VSCodeReviewHelper {
  constructor(private agent: ConversationalCodeAnalysis) {}

  async showInlineHints(analysis: AgentReviewContext): Promise<void> {
    for (const concern of analysis.concerns) {
      for (const file of concern.affectedFiles) {
        await this.addInlineDecoration(file, concern);
      }
    }
  }

  async provideHoverInformation(file: string, position: Position): Promise<HoverInfo> {
    const symbol = await this.getSymbolAtPosition(file, position);
    if (!symbol) return null;

    const impact = await this.agent.getSymbolImpact(symbol);
    return this.formatHoverInfo(symbol, impact);
  }

  async provideCodeActions(file: string, range: Range): Promise<CodeAction[]> {
    const suggestions = await this.agent.getSuggestions(file, range);
    return suggestions.map(s => this.createCodeAction(s));
  }
}
```

**Tasks**:
- [ ] Create VS Code extension interface
- [ ] Implement hover information providers
- [ ] Add inline decoration management
- [ ] Create code action providers
- [ ] Build review panel UI
- [ ] Write VS Code extension

### 6.3 Slack Integration

**File**: `src/integrations/slack.ts`

```typescript
export class SlackReviewNotifier {
  constructor(private webhookUrl: string) {}

  async notifyChannels(analysis: AgentReviewContext, pr: PullRequest): Promise<void> {
    const highRiskConcerns = analysis.concerns.filter(c => c.severity > 0.7);
    
    if (highRiskConcerns.length > 0) {
      await this.postToChannel("engineering-alerts", 
        this.formatHighRiskAlert(pr, highRiskConcerns)
      );
    }

    await this.postToChannel("code-reviews", 
      this.formatReviewSummary(pr, analysis)
    );
  }

  private formatReviewSummary(pr: PullRequest, analysis: AgentReviewContext): SlackMessage {
    return {
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `PR Review: ${pr.title}` }
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Risk Level:* ${analysis.changeProfile.riskLevel}` },
            { type: "mrkdwn", text: `*Complexity:* ${analysis.changeProfile.complexity}` }
          ]
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Review PR" },
              url: pr.url
            }
          ]
        }
      ]
    };
  }
}
```

**Tasks**:
- [ ] Create Slack webhook integration
- [ ] Implement message formatting
- [ ] Add channel routing logic
- [ ] Create alert prioritization
- [ ] Build interactive buttons
- [ ] Write Slack integration tests

## 🧪 Phase 7: Comprehensive Testing (Week 11)

### 7.1 Agent API Tests

**File**: `tests/agent/conversationalAgent.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationalCodeAnalysis } from '../../src/agent/conversationalAgent.js';

describe('ConversationalCodeAnalysis', () => {
  let agent: ConversationalCodeAnalysis;
  let mockPR: PRData;

  beforeEach(async () => {
    agent = new ConversationalCodeAnalysis(await buildTestIndex());
    mockPR = createMockPR();
  });

  it('should start conversation with structured summary', async () => {
    const conversation = await agent.startConversation(mockPR);
    
    expect(conversation.summary.changeProfile.type).toMatch(/feature|bugfix|refactor/);
    expect(conversation.summary.changeProfile.riskLevel).toMatch(/low|medium|high|critical/);
    expect(conversation.suggestedQuestions).toHaveLength.greaterThan(0);
    expect(conversation.conversationId).toBeDefined();
  });

  it('should parse risk assessment intent correctly', async () => {
    const conversation = await agent.startConversation(mockPR);
    
    const response = await agent.ask("What security risks does this change introduce?", conversation.conversationId);
    
    expect(response.type).toBe('risk-analysis');
    expect(response.risks).toBeDefined();
    expect(response.followUpQuestions).toHaveLength.greaterThan(0);
  });

  it('should accumulate context across questions', async () => {
    const conversation = await agent.startConversation(mockPR);
    
    await agent.ask("What are the main risks?", conversation.conversationId);
    const response2 = await agent.ask("How can I mitigate them?", conversation.conversationId);
    
    // Should reference previous risk discussion
    expect(response2.context?.previousQuestions).toContain("What are the main risks?");
  });
});
```

**Tasks**:
- [ ] Write comprehensive agent API tests
- [ ] Create conversation flow tests
- [ ] Add intent parsing tests
- [ ] Build context accumulation tests
- [ ] Write memory persistence tests
- [ ] Create performance benchmark tests

### 7.2 Integration Tests

**File**: `tests/integration/end-to-end.test.ts`

```typescript
describe('End-to-End Agent Workflows', () => {
  it('should complete full PR analysis workflow', async () => {
    const testRepo = await createTestRepository();
    const pr = await createTestPR(testRepo);
    
    // Test full agent workflow
    const agent = await createAgentForRepo(testRepo.path);
    const conversation = await agent.startConversation(pr);
    
    expect(conversation.summary.concerns).toBeDefined();
    expect(conversation.summary.changeProfile.riskLevel).toBeDefined();
    
    // Test follow-up questions
    const riskResponse = await agent.ask("What are the security implications?", conversation.conversationId);
    expect(riskResponse.type).toBe('risk-analysis');
    
    const testResponse = await agent.ask("What tests should I focus on?", conversation.conversationId);
    expect(testResponse.type).toBe('test-guidance');
  });

  it('should handle GitHub integration workflow', async () => {
    const githubBot = new GitHubReviewBot(mockAgent, mockFastQueries);
    const mockPR = createMockGitHubPR();
    
    await githubBot.handlePREvent(mockPR, { type: 'opened' });
    
    // Verify appropriate actions were taken
    expect(mockPR.comments).toHaveLength.greaterThan(0);
    expect(mockPR.comments[0]).toMatch(/AI Code Review Summary/);
  });
});
```

**Tasks**:
- [ ] Create end-to-end workflow tests
- [ ] Build integration test fixtures
- [ ] Add GitHub integration tests
- [ ] Create VS Code extension tests
- [ ] Write Slack integration tests
- [ ] Build performance regression tests

## 📦 Phase 8: CLI and API Updates (Week 12)

### 8.1 Enhanced CLI Interface

**File**: `src/cli-agent.ts`

```typescript
// Add agent-specific CLI commands
export async function handleAgentCommands(args: string[]): Promise<void> {
  const command = args[0];
  
  switch (command) {
    case 'analyze-pr':
      await handlePRAnalysis(args.slice(1));
      break;
    case 'chat':
      await handleChatMode(args.slice(1));
      break;
    case 'quick-risk':
      await handleQuickRisk(args.slice(1));
      break;
    case 'suggest-reviewers':
      await handleReviewerSuggestion(args.slice(1));
      break;
    default:
      console.log('Available agent commands: analyze-pr, chat, quick-risk, suggest-reviewers');
  }
}

async function handlePRAnalysis(args: string[]): Promise<void> {
  const options = parseAgentOptions(args);
  const agent = await createAgent(options.projectRoot);
  
  if (options.prNumber) {
    const pr = await fetchGitHubPR(options.prNumber, options);
    const conversation = await agent.startConversation(pr);
    console.log(JSON.stringify(conversation, null, 2));
  } else {
    const changes = await getLocalChanges(options);
    const conversation = await agent.startConversation({ changes });
    console.log(JSON.stringify(conversation, null, 2));
  }
}

async function handleChatMode(args: string[]): Promise<void> {
  const options = parseAgentOptions(args);
  const agent = await createAgent(options.projectRoot);
  
  console.log("🤖 Starting interactive chat mode. Type 'exit' to quit.");
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  let conversationId: string | null = null;
  
  while (true) {
    const question = await new Promise<string>(resolve => {
      rl.question('> ', resolve);
    });
    
    if (question.toLowerCase() === 'exit') break;
    
    if (!conversationId) {
      const changes = await getLocalChanges(options);
      const conversation = await agent.startConversation({ changes });
      conversationId = conversation.conversationId;
      console.log("📋 Analysis Summary:");
      console.log(conversation.summary);
      console.log("\n💬 Ask me anything about these changes...\n");
    }
    
    const response = await agent.ask(question, conversationId);
    console.log(formatResponse(response));
  }
  
  rl.close();
}
```

**Tasks**:
- [ ] Add agent-specific CLI commands
- [ ] Implement interactive chat mode
- [ ] Create PR analysis command
- [ ] Add quick risk assessment command
- [ ] Build reviewer suggestion command
- [ ] Update main CLI dispatcher
- [ ] Add CLI documentation

### 8.2 API Documentation

**File**: `docs/agent-api.md`

```markdown
# Agent API Documentation

## Core Classes

### ConversationalCodeAnalysis

The main interface for agent interactions.

#### Methods

**startConversation(prData: PRData): Promise<ConversationState>**
- Initializes analysis context for a PR or set of changes
- Returns structured summary and suggested questions

**ask(question: string, conversationId: string): Promise<AnalysisResponse>**
- Processes natural language questions about code changes
- Maintains conversation context

### SmartContextGatherer

Intelligent context assembly for enhanced analysis.

#### Methods

**gatherReviewContext(changes: FileChange[], options?: ContextOptions): Promise<ReviewContext>**
- Assembles comprehensive context including dependencies, risks, and business impact

### FastQueryInterface

High-performance queries for real-time interactions.

#### Methods

**quickRiskCheck(files: string[]): Promise<QuickRiskResult>**
- Sub-100ms risk assessment

**suggestReviewers(changes: FileChange[]): Promise<ReviewerSuggestion[]>**
- AI-powered reviewer recommendations
```

**Tasks**:
- [ ] Write comprehensive API documentation
- [ ] Create usage examples
- [ ] Add integration guides
- [ ] Document configuration options
- [ ] Create troubleshooting guide
- [ ] Build API reference

## 🚀 Phase 9: Performance Optimization (Week 13)

### 9.1 Benchmarking and Optimization

**File**: `tests/performance/benchmarks.test.ts`

```typescript
describe('Performance Benchmarks', () => {
  it('should complete quick risk assessment in < 100ms', async () => {
    const files = generateLargeFileSet(1000);
    const startTime = Date.now();
    
    const result = await fastQueries.quickRiskCheck(files);
    
    const duration = Date.now() - startTime;
    expect(duration).toBeLessThan(100);
    expect(result.responseTime).toBe("< 100ms");
  });

  it('should handle conversation startup in < 2 seconds', async () => {
    const largePR = generateLargePR(500); // 500 files changed
    const startTime = Date.now();
    
    const conversation = await agent.startConversation(largePR);
    
    const duration = Date.now() - startTime;
    expect(duration).toBeLessThan(2000);
    expect(conversation.summary).toBeDefined();
  });

  it('should maintain sub-second response times for follow-up questions', async () => {
    const conversation = await agent.startConversation(mockPR);
    
    const questions = [
      "What are the security risks?",
      "Which tests should I run?",
      "What files are most critical?",
      "Who should review this?"
    ];

    for (const question of questions) {
      const startTime = Date.now();
      const response = await agent.ask(question, conversation.conversationId);
      const duration = Date.now() - startTime;
      
      expect(duration).toBeLessThan(1000);
      expect(response.type).toBeDefined();
    }
  });
});
```

**Tasks**:
- [ ] Create comprehensive performance benchmarks
- [ ] Identify and optimize bottlenecks
- [ ] Implement response time monitoring
- [ ] Add memory usage optimization
- [ ] Create performance regression tests
- [ ] Optimize cache strategies

## 📚 Phase 10: Documentation and Examples (Week 14)

### 10.1 Comprehensive Documentation

**File**: `docs/agent-guide.md`

```markdown
# AI Agent Integration Guide

## Quick Start

```typescript
import { ConversationalCodeAnalysis, buildProjectIndex } from 'codegraph';

// Initialize agent
const index = await buildProjectIndex('./my-project');
const agent = new ConversationalCodeAnalysis(index);

// Start conversation about a PR
const conversation = await agent.startConversation({
  changes: prChanges,
  metadata: { prNumber: 123, author: 'developer' }
});

// Ask questions
const riskAnalysis = await agent.ask(
  "What security risks does this PR introduce?", 
  conversation.conversationId
);
```

## Integration Patterns

### GitHub Bot
[Detailed GitHub bot setup and configuration]

### VS Code Extension  
[Extension development and integration steps]

### Slack Notifications
[Slack webhook and bot configuration]

## Advanced Usage

### Custom Risk Patterns
[How to add domain-specific risk detection]

### Memory and Learning
[Configuring agent learning and memory]

### Performance Tuning
[Optimization strategies for large codebases]
```

### 10.2 Example Implementations

**File**: `examples/github-bot/`

```typescript
// Complete GitHub bot example
// examples/slack-notifier/
// Complete Slack integration example
// examples/vscode-extension/
// VS Code extension example
```

**Tasks**:
- [ ] Write comprehensive user guide
- [ ] Create integration tutorials
- [ ] Build complete examples
- [ ] Add troubleshooting documentation
- [ ] Create video tutorials (optional)
- [ ] Build interactive demos

## 📋 Final Checklist

### Technical Requirements
- [ ] All new APIs have TypeScript types
- [ ] Test coverage > 80% for new code
- [ ] Performance benchmarks meet targets
- [ ] Memory usage is optimized
- [ ] Error handling is comprehensive
- [ ] Logging is implemented throughout

### Documentation Requirements  
- [ ] API documentation is complete
- [ ] Integration guides are written
- [ ] Examples are provided
- [ ] README is updated
- [ ] CHANGELOG is updated

### Quality Assurance
- [ ] All tests pass
- [ ] Linting passes
- [ ] Type checking passes
- [ ] Performance benchmarks meet targets
- [ ] Manual testing completed
- [ ] Integration tests pass

## 🎯 Success Metrics

By completion, the library should achieve:

- **Performance**: < 100ms for quick queries, < 2s for full analysis
- **Usability**: Single method call for common operations
- **Intelligence**: Context-aware responses with confidence scores
- **Scalability**: Handle repositories with 10,000+ files
- **Extensibility**: Easy to add new analysis types
- **Integration**: Ready-made connectors for GitHub, Slack, VS Code

## 📞 Getting Help

If you get stuck during implementation:

1. Check existing code patterns in `src/impact/` and `src/indexer.ts`
2. Review test files for usage examples
3. Use the existing Tree-sitter queries in `src/languages/`
4. Build incrementally and test frequently
5. Ask for code review early and often

Remember: This is a significant enhancement, but it builds on solid foundations. Take it one phase at a time, and don't hesitate to adjust the plan as you learn more about the codebase.