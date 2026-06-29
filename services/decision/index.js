import { DecisionTracer } from './tracer.js';

let tracer;

export function getTracer() {
  if (!tracer) tracer = new DecisionTracer();
  return tracer;
}

export { DecisionTracer };
