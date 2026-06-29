#!/usr/bin/env node
import { getDb } from '../data/db.js';

const db = getDb();

const dim = '\x1b[2m';
const reset = '\x1b[0m';
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const red = '\x1b[31m';
const cyan = '\x1b[36m';
const bold = '\x1b[1m';

function bar(count, total, width = 25) {
  const filled = total > 0 ? Math.round((count / total) * width) : 0;
  return '█'.repeat(Math.min(filled, width)) + '░'.repeat(Math.max(width - filled, 0));
}

console.log(`
╔══════════════════════════════════════════════════════════════╗
║      ${bold}Knowledge Trace: LLM → Knowledge → Reuse${reset}           ║
╚══════════════════════════════════════════════════════════════╝
`);

// ── 1. Extract Full Decision Chains Per Event ──
const chains = db.prepare(`
  SELECT dl1.event_id, 
         dl1.id AS decision_id,
         dl1.step, 
         dl1.decision, 
         dl1.confidence,
         dl1.reasoning_chain,
         dl1.duration_ms,
         e.event_type,
         pr.pr_number,
         pr.status AS pr_status,
         te.outcome
  FROM decision_logs dl1
  JOIN events e ON e.id = dl1.event_id
  LEFT JOIN prs pr ON pr.event_id = dl1.event_id
  LEFT JOIN truth_events te ON te.event_id = dl1.event_id
  ORDER BY dl1.event_id, dl1.id
`).all();

const events = {};
for (const row of chains) {
  if (!events[row.event_id]) events[row.event_id] = { id: row.event_id, decisions: [] };
  events[row.event_id].decisions.push(row);
}

console.log(`${dim}Total events traced: ${Object.keys(events).length}${reset}`);
console.log(`${dim}Total decision steps: ${chains.length}${reset}`);
console.log();

// ── 2. Answer the 4 Questions Per Event ──
const Q1 = 'LLM vs Knowledge?';
const Q2 = 'Knowledge created?';
const Q3 = 'Knowledge reused?';
const Q4 = 'Result vs baseline?';

let totalLLM = 0, totalKnowledge = 0;
let totalKnowledgeCreated = 0, totalKnowledgeReused = 0;
let llmSuccess = 0, knowledgeSuccess = 0;

for (const [eventId, event] of Object.entries(events)) {
  console.log(`\n${bold}Event: ${eventId}${reset}`);
  console.log(`  ${dim}${'─'.repeat(60)}${reset}`);

  const dec = event.decisions;
  
  // Q1: Did any step use LLM vs memory/knowledge?
  const llmStep = dec.find(d => d.decision === 'LLM_GENERATED');
  const memoryHitStep = dec.find(d => d.decision === 'MEMORY_HIT');
  const memoryMissStep = dec.find(d => d.decision === 'MEMORY_MISS');
  const patternStep = dec.find(d => d.decision && d.step === 'memory_lookup');
  
  const usedLLM = !!llmStep;
  const usedKnowledge = !!memoryHitStep;
  const missedMemory = !!memoryMissStep;
  const createdPR = dec.some(d => d.decision === 'PR_CREATED');
  const outcome = dec.find(d => d.outcome)?.outcome || createdPR ? 'pr_created' : 'pipeline_incomplete';
  const prNumber = dec.find(d => d.pr_number)?.pr_number;
  const prStatus = dec.find(d => d.pr_status)?.pr_status;

  if (usedLLM) totalLLM++;
  if (usedKnowledge) totalKnowledge++;

  // Print the trace
  for (const d of dec) {
    const icon = d.decision === 'LLM_GENERATED' ? '🤖' 
               : d.decision === 'MEMORY_HIT' ? '💾'
               : d.decision === 'MEMORY_MISS' ? '🔍'
               : d.decision === 'PR_CREATED' ? '✅'
               : d.decision === 'SAFETY_PASSED' ? '🛡️'
               : d.decision === 'VERIFICATION_PASSED' ? '🔬'
               : d.decision === 'TRUST_APPROVED' ? '⚖️'
               : '  ';
    const color = d.decision === 'LLM_GENERATED' ? yellow
                : d.decision === 'MEMORY_HIT' ? green
                : d.decision === 'MEMORY_MISS' ? yellow
                : d.decision === 'PR_CREATED' ? green
                : dim;
    const reasoning = d.reasoning_chain && d.reasoning_chain !== '[]' 
      ? JSON.parse(d.reasoning_chain).join(' → ') : '';
    console.log(`  ${color}${icon} ${d.step.padEnd(20)} ${d.decision.padEnd(20)} ${(d.confidence * 100).toFixed(0).padStart(3)}%${reset}`);
    if (reasoning) console.log(`  ${dim}     └─ ${reasoning}${reset}`);
  }

  // Q1 answer
  if (usedKnowledge) {
    console.log(`  ${green}✓ Q1: Knowledge-based (memory hit, no LLM needed)${reset}`);
  } else if (usedLLM) {
    console.log(`  ${yellow}✓ Q1: LLM-based (memory miss → generated)${reset}`);
  } else {
    console.log(`  ${dim}  Q1: Pipeline only (no generation step needed)${reset}`);
  }

  // Q2 & Q3 for knowledge creation/reuse
  if (usedLLM && createdPR) {
    totalKnowledgeCreated++;
    console.log(`  ${yellow}✓ Q2: LLM produced output → knowledge COULD be stored${reset}`);
    if (prNumber) console.log(`  ${yellow}✓ Q4: PR #${prNumber} created (${prStatus || 'pending'})${reset}`);
  } else if (usedKnowledge && createdPR) {
    totalKnowledgeReused++;
    console.log(`  ${green}✓ Q3: Knowledge was reused → PR created${reset}`);
    knowledgeSuccess++;
  } else if (usedKnowledge) {
    totalKnowledgeReused++;
    console.log(`  ${green}✓ Q3: Knowledge was reused${reset}`);
  }

  if (llmStep) {
    // The LLM step's reasoning chain tells us what was generated
    const llmReasoning = llmStep.reasoning_chain && llmStep.reasoning_chain !== '[]'
      ? JSON.parse(llmStep.reasoning_chain) : [];
    console.log(`  ${dim}     └─ LLM source: ${llmReasoning.join(', ') || 'unknown'}${reset}`);
  }
  
  if (memoryHitStep) {
    const reason = memoryHitStep.reasoning_chain && memoryHitStep.reasoning_chain !== '[]'
      ? JSON.parse(memoryHitStep.reasoning_chain) : [];
    console.log(`  ${green}     └─ Source: ${reason.join(', ') || 'pattern match'}${reset}`);
  }
}

// ── 3. Summary Statistics ──
console.log(`\n${bold}${'═'.repeat(60)}${reset}`);
console.log(`${bold}  KNOWLEDGE ACCUMULATION SUMMARY${reset}`);
console.log(`  ${dim}${'─'.repeat(60)}${reset}`);

const totalPRs = db.prepare(`SELECT COUNT(*) AS c FROM prs`).get().c;
const totalPatterns = db.prepare(`SELECT COUNT(*) AS c FROM patterns`).get().c;
const patternUsageCount = db.prepare(`SELECT COALESCE(SUM(times_used),0) AS c FROM patterns`).get().c;
const memoryHitCount = db.prepare(`SELECT COALESCE(SUM(hit_count),0) AS c FROM memory_cache`).get().c;

console.log(`  Total events processed:     ${String(Object.keys(events).length).padStart(6)}`);
console.log(`  Total PRs created:          ${String(totalPRs).padStart(6)}`);
console.log(`  Patterns learned:           ${String(totalPatterns).padStart(6)}`);
console.log(`  Pattern usage count:        ${String(patternUsageCount).padStart(6)}`);
console.log(`  Memory cache entries:       ${String(db.prepare('SELECT COUNT(*) AS c FROM memory_cache').get().c).padStart(6)}`);
console.log(`  Memory cache hits:          ${String(memoryHitCount).padStart(6)}`);

console.log(`\n  ${bold}Q1: LLM vs Knowledge split:${reset}`);
const totalDecided = totalLLM + totalKnowledge;
if (totalDecided > 0) {
  const llmPct = ((totalLLM / totalDecided) * 100).toFixed(1);
  const knowPct = ((totalKnowledge / totalDecided) * 100).toFixed(1);
  console.log(`    ${yellow}🤖 LLM-based:  ${totalLLM.toString().padStart(4)} (${llmPct}%)  ${bar(totalLLM, totalDecided)}${reset}`);
  console.log(`    ${green}💾 Knowledge:  ${totalKnowledge.toString().padStart(4)} (${knowPct}%)  ${bar(totalKnowledge, totalDecided)}${reset}`);
} else {
  console.log(`    ${dim}No generation events yet${reset}`);
}

console.log(`\n  ${bold}Q2 + Q3: Knowledge lifecycle:${reset}`);
console.log(`    ${yellow}LLM → Output (could create knowledge): ${totalKnowledgeCreated}${reset}`);
console.log(`    ${green}Knowledge reused:                      ${totalKnowledgeReused}${reset}`);
if (totalKnowledge > 0) {
  const reuseRate = ((totalKnowledgeReused / (totalKnowledge + totalKnowledgeCreated)) * 100).toFixed(1);
  console.log(`    Knowledge reuse rate: ${reuseRate}%`);
}
if (totalLLM > 0) {
  console.log(`    LLM → Knowledge conversion: ${((totalKnowledgeCreated / totalLLM) * 100).toFixed(1)}%`);
}

console.log(`\n  ${bold}Q4: Outcome by source:${reset}`);
console.log(`    ${yellow}LLM-based PRs:       ${llmSuccess} created${reset}`);
console.log(`    ${green}Knowledge-based PRs: ${knowledgeSuccess} created${reset}`);
const accuracyBySource = db.prepare(`
  SELECT 'LLM' AS source, SUM(total) AS total, SUM(correct) AS correct
  FROM accuracy_metrics WHERE fix_type IN ('ci_failure','dependency')
  UNION ALL
  SELECT 'Knowledge' AS source, SUM(total) AS total, SUM(correct) AS correct
  FROM accuracy_metrics WHERE fix_type = 'lint'
`).all();
for (const row of accuracyBySource) {
  if (row.total > 0) {
    console.log(`    ${row.source.padEnd(20)} ${String(row.total).padStart(4)} total, ${String(row.correct).padStart(4)} correct (${((row.correct/row.total)*100).toFixed(1)}%)`);
  }
}

// ── 4. Calibration History ──
console.log(`\n${bold}  TRUTH CALIBRATION TABLE${reset}`);
console.log(`  ${dim}${'─'.repeat(60)}${reset}`);
const cal = db.prepare(`SELECT * FROM truth_calibration`).all();
if (cal.length > 0) {
  for (const row of cal) {
    const hist = row.history && row.history !== '[]' ? JSON.parse(row.history) : [];
    console.log(`  ${row.metric.padEnd(30)} current=${String(row.current_value).padStart(6)}  samples=${String(row.sample_size).padStart(4)}  history=[${hist.join(', ')}]`);
  }
} else {
  console.log(`  ${dim}(empty - no data recorded yet)${reset}`);
  console.log(`  ${dim}  This table is ready to track:${reset}`);
  console.log(`  ${dim}    - llm_per_pr: LLM calls per successful PR${reset}`);
  console.log(`  ${dim}    - knowledge_reuse_rate: % of PRs using cached knowledge${reset}`);
  console.log(`  ${dim}    - memory_hit_rate: % of memory lookups that hit${reset}`);
  console.log(`  ${dim}    - avg_llm_cost: average LLM cost per PR${reset}`);
  console.log(`  ${dim}    - pattern_accept_rate: % of patterns accepted on use${reset}`);
}

// ── 5. The Trend That Matters ──
console.log(`\n${bold}  THE CURVE THAT MATTERS${reset}`);
console.log(`  ${dim}  If LLM usage per PR drops over time while knowledge reuse rises,${reset}`);
console.log(`  ${dim}  the system is building a compounding knowledge asset.${reset}`);
console.log(`  ${dim}${'─'.repeat(60)}${reset}`);

// Simulate what the curve would look like with real data
// Pick a recent pattern and show its reuse rate
const mostUsedPattern = db.prepare(`
  SELECT fix_type, times_used, times_accepted, 
          ROUND(100.0 * times_accepted / NULLIF(times_accepted + times_rejected, 0), 1) AS accept_rate
  FROM patterns ORDER BY times_used DESC LIMIT 1
`).get();
if (mostUsedPattern && mostUsedPattern.times_used > 1) {
  console.log(`  Best pattern: ${mostUsedPattern.fix_type} (used ${mostUsedPattern.times_used}x, ${mostUsedPattern.accept_rate}% accept)`);
  console.log(`  Each reuse saved LLM cost: est. $0.03 per call`);
  console.log(`  Total savings so far: $${(0.03 * (mostUsedPattern.times_used - 1)).toFixed(2)}`);
  console.log(`  (first call costs LLM, subsequent calls reuse knowledge)`);
}

console.log(`\n  ${dim}Generated: ${new Date().toISOString()}${reset}`);
console.log();
