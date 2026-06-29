import { getTracer } from '../../services/decision/index.js';

export async function handleExplainRequest(req, res) {
  try {
    const { eventId } = req.query;
    if (!eventId) {
      return res.status(400).json({ error: 'query param ?eventId= required' });
    }
    const tracer = getTracer();
    const explanation = tracer.explain(eventId);
    if (!explanation || explanation.totalSteps === 0) {
      return res.status(404).json({ error: 'No trace found for this eventId', eventId });
    }
    res.json(explanation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function handleWhyRequest(req, res) {
  try {
    const { eventId } = req.query;
    if (!eventId) {
      return res.status(400).json({ error: 'query param ?eventId= required' });
    }
    const tracer = getTracer();
    const why = tracer.why(eventId);
    if (!why) {
      return res.status(404).json({ error: 'No trace found for this eventId', eventId });
    }
    res.json(why);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function handleTraceRequest(req, res) {
  try {
    const { eventId } = req.query;
    if (!eventId) {
      return res.status(400).json({ error: 'query param ?eventId= required' });
    }
    const tracer = getTracer();
    const trace = tracer.getTrace(eventId);
    if (!trace || trace.decisions.length === 0) {
      return res.status(404).json({ error: 'No trace found for this eventId', eventId });
    }
    res.json(trace);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
