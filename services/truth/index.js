import { TruthTracker } from './tracker.js';
import { TruthReconciler } from './reconciler.js';
import { Calibrator } from './calibrator.js';
import { TruthMetrics } from './metrics.js';

let tracker;
let reconciler;
let calibrator;
let metrics;

export function getTruthTracker() {
  if (!tracker) tracker = new TruthTracker();
  return tracker;
}

export function getTruthReconciler() {
  if (!reconciler) reconciler = new TruthReconciler();
  return reconciler;
}

export function getCalibrator() {
  if (!calibrator) calibrator = new Calibrator();
  return calibrator;
}

export function getTruthMetrics() {
  if (!metrics) metrics = new TruthMetrics();
  return metrics;
}
