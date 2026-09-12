// Public surface of the review engine, consumed by the Action
// in this repository and by the hosted Shrike server.
export { getBackend, backends } from "./backends";
export type { Backend, AgentSession } from "./backends";
export { PullRequestClient } from "./github";
export type { PullRequest, PullRequestHistory } from "./github";
export { jobFromEvent, jobSchema, parseTrigger } from "./job";
export type { Job } from "./job";
export { parseReport, parseShriken, parseShrikenScores, reportSchema, shrikenReferences } from "./report";
export type { Report, Finding, ShrikenReference } from "./report";
export { runJob, renderStatus, runRecord, SHRIKEN } from "./runner";
export type { RunDeps, ReviewRun, RunRecord, Turn } from "./runner";
export { AUTOFIX, TRAILER } from "./autofix";
export type { AutofixDeps, PushIdentity } from "./autofix";
export { actionsIdToken, DEFAULT_REVIEWS, OIDC_AUDIENCE, resolveSettings, reviewSchema, SettingsApi, settingsSchema } from "./settings";
export type { AutofixMode, Review, Settings } from "./settings";
