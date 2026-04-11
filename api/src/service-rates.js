// Central rate card and per-service policy.
// Edit this file to change pricing or risk routing — no other file needs to be touched.
//
// riskCategory:
//   "safe"   → quote generated and shown instantly in the chat (tutoring, writing, data)
//   "review" → quote drafted, emailed to Reza for review, client gets holding message
//
// sampleFormat is a short spec passed to Claude describing what the preview sample
// should look like. Keep samples *structural/methodological*, never with specific
// engineering numbers — hallucinated values are a liability risk.

export const SERVICE_RATES = {
  tutoring: {
    label: "University-level civil engineering tutoring",
    rate: "£65 per hour",
    typicalEngagement: "4-8 sessions per topic, each 1.0-1.5 hours, delivered online worldwide or in-person in Birmingham",
    minimum: "1 hour (£65)",
    riskCategory: "safe",
    sampleFormat:
      "One worked example problem on the topic the student is struggling with, shown step-by-step with the reasoning explained clearly. Plus a 4-6 item lesson plan for a typical engagement. Neutral, explanatory tone suitable for a university student.",
  },

  writing: {
    label: "Technical writing",
    rate: "£0.25-0.40 per word, or £80-120 per hour — typical minimum project £200",
    typicalEngagement:
      "Technical reports, journal papers, white papers, proposals, case studies, monitoring reports",
    minimum: "£200",
    riskCategory: "safe",
    sampleFormat:
      "A sample opening paragraph (150-200 words) written in the target style (academic / industry white paper / report) on the topic the client mentioned. Plus a short outline of sections a full deliverable would cover. UK English.",
  },

  data: {
    label: "Engineering data analytics",
    rate: "£80-150 per hour, or £400-800 per day; small projects from £300",
    typicalEngagement:
      "Time-series analysis of monitoring data, sensor data processing, outlier detection, visualisation, automated pipelines in Python/MATLAB",
    minimum: "£300",
    riskCategory: "safe",
    sampleFormat:
      "A methodology outline (3-5 steps) plus a Python code skeleton showing the analysis structure with <<placeholder>> tokens for all values. Do not invent data, thresholds, or numerical parameters. Show imports, function signatures, and comments describing what each step would do.",
  },

  fea: {
    label: "Finite Element Analysis / ABAQUS modelling",
    rate: "£500-800 per day; simple models from £1,000; complex non-linear projects £3,000-15,000",
    typicalEngagement:
      "5-20 working days depending on complexity. Deliverables usually include model files, calibration report, results visualisation, and technical summary.",
    minimum: "£1,000",
    riskCategory: "review",
    sampleFormat:
      "A modelling approach document: recommended element type and justification, boundary condition strategy, suggested material model, solver approach (implicit/explicit), and known pitfalls to watch for. Absolutely no specific numerical values (no element sizes, no parameters, no safety factors). Use <<placeholder>> language where a number would go.",
  },

  infrastructure: {
    label: "Infrastructure assessment",
    rate: "Desktop review from £500; site visit + report from £1,500; full assessment from £5,000",
    typicalEngagement:
      "Desktop feasibility through to full structural assessment with monitoring recommendations. Always starts with a scoping call.",
    minimum: "£500",
    riskCategory: "review",
    sampleFormat:
      "An assessment methodology outline listing the phases (desktop review → site inspection → testing → analysis → reporting) and a scoping checklist of information Dr Movahedifar would request from the client. No specific recommendations or numerical values.",
  },

  shm: {
    label: "Structural Health Monitoring design",
    rate: "Advisory calls from £500; monitoring plan from £2,000; full SHM design £10,000+",
    typicalEngagement:
      "Advisory through to multi-year monitoring programmes. Scope depends on structure type, monitoring duration, and data delivery requirements.",
    minimum: "£500",
    riskCategory: "review",
    sampleFormat:
      "A monitoring strategy outline: what would be measured and why, sensor type rationale (strain / displacement / vibration / fibre optic), data handling approach, and expected deliverables. No specific sensor counts, placements, or thresholds.",
  },

  "fibre-optic": {
    label: "Fibre optic sensing consulting",
    rate: "Advisory from £500; system specification from £2,000; full system design £10,000+",
    typicalEngagement:
      "Advisory calls, interrogator / cable specification, installation planning, data processing pipelines. Engagement length varies from days to months.",
    minimum: "£500",
    riskCategory: "review",
    sampleFormat:
      "A sensing strategy outline: DFOS vs point sensors rationale, interrogator selection criteria (Brillouin / Rayleigh / FBG), cable type considerations, installation approach, and data handling workflow. No specific spatial resolutions, wavelengths, or numerical thresholds.",
  },

  other: {
    label: "Other engineering consulting",
    rate: "From £500 per engagement depending on scope — always requires a scoping call",
    typicalEngagement: "Variable",
    minimum: "£500",
    riskCategory: "review",
    sampleFormat:
      "A scoping outline listing the questions Dr Movahedifar would need answered before providing a firm quote, and a general framing of how he would approach the problem.",
  },
};

export function getRates(service) {
  return SERVICE_RATES[service] || SERVICE_RATES.other;
}

export function isSafeService(service) {
  return getRates(service).riskCategory === "safe";
}
