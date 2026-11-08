/** Validate identity and structure, not the model's taste or correctness. */
export function validateReview(text, receipt) {
  const value = JSON.parse(text);
  if (!value || value.evidenceId !== receipt.evidenceId || typeof value.summary !== 'string' || !value.summary.trim() || !Array.isArray(value.findings) || value.findings.length > 100) throw new Error('Review has invalid identity, summary, or findings');
  const images = new Map(receipt.images.map(image => [image.captureId, image.sha256]));
  for (const finding of value.findings) {
    if (!finding || !images.has(finding.captureId) || images.get(finding.captureId) !== finding.imageSha256) throw new Error('Finding references an unoffered image');
    if (!['low','medium','high'].includes(finding.severity)) throw new Error('Finding severity is invalid');
    for (const field of ['region','observation','impact','remedy','uncertainty']) if (typeof finding[field] !== 'string' || !finding[field].trim()) throw new Error(`Finding is missing ${field}`);
  }
  return value;
}
