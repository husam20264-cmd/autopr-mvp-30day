import { SwitchDetector } from './switch.js';
import { RuleMutator } from './mutator.js';
import { PolicyPromoter } from './promoter.js';
import { ApiLearner } from './apiLearner.js';
import { TrapDetector } from './trapDetector.js';

let switchDetector;
let ruleMutator;
let policyPromoter;
let apiLearner;
let trapDetector;

export function getSwitchDetector() {
  if (!switchDetector) switchDetector = new SwitchDetector();
  return switchDetector;
}

export function getRuleMutator() {
  if (!ruleMutator) ruleMutator = new RuleMutator();
  return ruleMutator;
}

export function getPolicyPromoter() {
  if (!policyPromoter) policyPromoter = new PolicyPromoter();
  return policyPromoter;
}

export function getApiLearner() {
  if (!apiLearner) apiLearner = new ApiLearner();
  return apiLearner;
}

export function getTrapDetector() {
  if (!trapDetector) trapDetector = new TrapDetector();
  return trapDetector;
}

export async function runMetaCognitionCycle() {
  const results = {};

  const promoter = getPolicyPromoter();
  results.promotions = promoter.evaluatePatternsForPromotion();
  results.verification = promoter.verifyPolicies();

  const mutator = getRuleMutator();
  results.mutations = mutator.mutateAll();
  results.archived = mutator.archiveDeadRules(30);

  return results;
}
