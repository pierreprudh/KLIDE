export const terminal = new Set(['settled', 'failed', 'cancelled', 'budget', 'stalled', 'human-decision-required']);
export function limits(state, now = Date.now()) {
    return now >= state.deadline || state.attempts >= state.maxAttempts;
}
export function reviewOutcome(state, review) {
    if (review.humanDecisionRequired === true)
        return { ...state, phase: 'human-decision-required', reason: 'Unresolved preference tradeoff' };
    if (!review.findings.length)
        return { ...state, phase: 'settled', reason: 'no-actionable-findings', bestCandidate: state.candidate };
    const issues = review.findings.map(f => `${f.region}|${f.observation}`.toLowerCase().replace(/\s+/g, ' ').trim()).sort();
    const resolved = (state.issues ?? []).some(issue => !issues.includes(issue));
    const stagnant = state.issues ? (resolved ? 0 : state.stagnant + 1) : 0;
    if (stagnant >= 2)
        return { ...state, phase: 'stalled', reason: 'Two cycles resolved no previously recorded issue', issues, stagnant };
    if (state.cycles >= state.maxCycles)
        return { ...state, phase: 'budget', reason: 'Revision limit reached', issues, stagnant };
    return { ...state, phase: 'revising', issues, stagnant, findings: review.findings };
}
export function resumeState(state) {
    if (state.phase !== 'waiting-native')
        throw Error('Cannot replay an in-flight or terminal trial. Reconcile recorded Runs and source hashes explicitly; create a new trial for further work.');
    return { ...state, phase: state.resumePhase };
}
