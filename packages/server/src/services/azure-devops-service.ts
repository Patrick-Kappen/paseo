import { z } from "zod";
import { CHECK_TRAIT_ACTION_REQUIRED, CHECK_TRAIT_WARNING } from "@getpaseo/protocol/check-traits";
import { normalizeHost, parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { findExecutable } from "../executable-resolution/executable-resolution.js";
import { execCommand } from "../utils/spawn.js";
import {
  bufferOrStringToString,
  createCachedCliPathResolver,
  defaultResolveRemoteUrl,
  ForgeAuthenticationError,
  ForgeCliMissingError,
  ForgeCommandError,
} from "./forge-cli-command.js";
import {
  compareTimelineItems,
  computeChecksStatus,
  createUnavailableSearchResult,
  normalizeForgeSearchKinds,
  parseOptionalTime,
} from "./forge-service.js";
import type {
  CheckAnnotation,
  CheckDetails,
  CheckFailedJob,
  CreatePullRequestOptions,
  CurrentPullRequestStatus,
  DisablePullRequestAutoMergeOptions,
  EnablePullRequestAutoMergeOptions,
  ForgeReadOptions,
  ForgeService,
  GetCheckDetailsOptions,
  GetPullRequestOptions,
  GetPullRequestTimelineOptions,
  IssueSummary,
  ListIssuesOptions,
  ListPullRequestsOptions,
  MergePullRequestOptions,
  PipelineDetails,
  PipelineJob,
  PipelineJobStatus,
  PipelineStage,
  PullRequestAutoMergeResult,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestCheckoutTarget,
  PullRequestCreateResult,
  PullRequestMergeable,
  PullRequestMergeMethod,
  PullRequestMergeResult,
  PullRequestReviewDecision,
  PullRequestSummary,
  PullRequestTimeline,
  PullRequestTimelineCommentLocation,
  PullRequestTimelineError,
  PullRequestTimelineItem,
  SearchIssuesAndPrsOptions,
  SearchResult,
} from "./forge-service.js";
import type { AzureDevOpsMergeMethod, AzureDevOpsStatusFacts } from "./azure-devops-facts.js";

// Azure DevOps' fixed Entra resource id; tokens for it work against every organization.
const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const API_VERSION = "7.1";
const POLICY_API_VERSION = "7.1-preview.1";
const REQUEST_TIMEOUT_MS = 30_000;
const AZ_TIMEOUT_MS = 60_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const LOG_TAIL_CHARS = 4_000;
const MAX_FAILED_LOGS = 5;
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

const BUILD_POLICY_TYPE = "0609b952-1397-4640-95ec-e00a01b2c241";
const STATUS_POLICY_TYPE = "cbdc66da-9728-4af8-aada-9a5a32e4a226";
const MERGE_STRATEGY_POLICY_TYPE = "fa4e907d-c16b-4a4c-9dfa-4916e5d171ab";

const CLOSED_WORK_ITEM_STATES = new Set(["closed", "done", "removed", "resolved", "completed"]);
const RESOLVED_THREAD_STATES = new Set(["fixed", "closed", "wontfix", "bydesign"]);

export class AzureDevOpsCliMissingError extends ForgeCliMissingError {
  constructor() {
    super("Azure CLI (az) is not installed");
    this.name = "AzureDevOpsCliMissingError";
  }
}

export class AzureDevOpsAuthenticationError extends ForgeAuthenticationError {
  constructor(params: { stderr: string }) {
    super("Azure DevOps is not signed in; run az login", params);
    this.name = "AzureDevOpsAuthenticationError";
  }
}

export class AzureDevOpsRequestError extends ForgeCommandError {
  readonly status: number | null;

  constructor(params: { method: string; path: string; status: number | null; message: string }) {
    super(
      { brand: "Azure DevOps", binary: "az" },
      {
        args: [params.method, params.path],
        cwd: "",
        exitCode: params.status,
        stderr: params.message,
      },
    );
    this.name = "AzureDevOpsRequestError";
    this.status = params.status;
    this.message = `Azure DevOps request failed (${params.status ?? "no response"}): ${params.method} ${params.path}: ${params.message}`;
  }
}

export interface AzureDevOpsRepository {
  organization: string;
  project: string;
  repository: string;
}

export interface AzureDevOpsCredential {
  authorization: string;
}

export type AzureDevOpsFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CreateAzureDevOpsServiceOptions {
  resolveRemoteUrl?: (cwd: string) => Promise<string | null>;
  getCredential?: (options: { refresh: boolean }) => Promise<AzureDevOpsCredential>;
  fetch?: AzureDevOpsFetch;
}

export function isAzureDevOpsHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return (
    normalized === "dev.azure.com" ||
    normalized === "ssh.dev.azure.com" ||
    normalized === "vs-ssh.visualstudio.com" ||
    normalized.endsWith(".visualstudio.com")
  );
}

/**
 * Accepts every remote shape Azure DevOps hands out:
 * https://[user@]dev.azure.com/{org}/{project}/_git/{repo},
 * git@ssh.dev.azure.com:v3/{org}/{project}/{repo},
 * https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo},
 * {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}.
 * `/{org}/_git/{repo}` is the short form for a repository named like its project.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseAzureDevOpsRemote(remoteUrl: string): AzureDevOpsRepository | null {
  const location = parseGitRemoteLocation(remoteUrl);
  if (!location || !isAzureDevOpsHost(location.host)) {
    return null;
  }
  const host = normalizeHost(location.host);
  const segments = location.path.split("/").filter(Boolean).map(decodeSegment);
  if (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") {
    const [version, organization, project, repository] = segments;
    if (version !== "v3" || !organization || !project || !repository || segments.length !== 4) {
      return null;
    }
    return { organization, project, repository };
  }
  let organization: string | undefined;
  let rest: string[];
  if (host === "dev.azure.com") {
    [organization, ...rest] = segments;
  } else {
    organization = host.slice(0, -".visualstudio.com".length);
    rest = segments[0]?.toLowerCase() === "defaultcollection" ? segments.slice(1) : segments;
  }
  const gitIndex = rest.indexOf("_git");
  if (!organization || gitIndex < 0 || gitIndex > 1 || rest.length !== gitIndex + 2) {
    return null;
  }
  const repository = rest[gitIndex + 1];
  const project = gitIndex === 1 ? rest[0] : repository;
  if (!project || !repository) {
    return null;
  }
  return { organization, project, repository };
}

function organizationUrl(repo: Pick<AzureDevOpsRepository, "organization">): string {
  return `https://dev.azure.com/${encodeURIComponent(repo.organization)}`;
}

function projectUrl(repo: Pick<AzureDevOpsRepository, "organization" | "project">): string {
  return `${organizationUrl(repo)}/${encodeURIComponent(repo.project)}`;
}

function repositoryApiPath(repo: AzureDevOpsRepository): string {
  return `${encodeURIComponent(repo.project)}/_apis/git/repositories/${encodeURIComponent(repo.repository)}`;
}

function pullRequestWebUrl(repo: AzureDevOpsRepository, number: number): string {
  return `${projectUrl(repo)}/_git/${encodeURIComponent(repo.repository)}/pullrequest/${number}`;
}

function workItemWebUrl(repo: AzureDevOpsRepository, id: number): string {
  return `${projectUrl(repo)}/_workitems/edit/${id}`;
}

function buildWebUrl(repo: AzureDevOpsRepository, buildId: number): string {
  return `${projectUrl(repo)}/_build/results?buildId=${buildId}`;
}

function stripRefsHeads(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

function toRefsHeads(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

const IdentitySchema = z
  .object({
    id: z.string().optional(),
    displayName: z.string().optional().default(""),
    uniqueName: z.string().optional(),
  })
  .passthrough();

const ReviewerSchema = IdentitySchema.extend({
  vote: z.number().optional().default(0),
  isRequired: z.boolean().optional().default(false),
});

const CompletionOptionsSchema = z
  .object({
    mergeStrategy: z.string().optional(),
    deleteSourceBranch: z.boolean().optional(),
    transitionWorkItems: z.boolean().optional(),
    mergeCommitMessage: z.string().optional(),
    squashMerge: z.boolean().optional(),
    bypassPolicy: z.boolean().optional(),
  })
  .passthrough();

const PullRequestSchema = z
  .object({
    pullRequestId: z.number(),
    status: z.string(),
    title: z.string().optional().default(""),
    description: z.string().nullish(),
    sourceRefName: z.string(),
    targetRefName: z.string(),
    isDraft: z.boolean().optional().default(false),
    mergeStatus: z.string().nullish(),
    creationDate: z.string().optional(),
    closedDate: z.string().nullish(),
    createdBy: IdentitySchema.optional(),
    reviewers: z.array(ReviewerSchema).optional().default([]),
    labels: z
      .array(z.object({ name: z.string(), active: z.boolean().optional() }).passthrough())
      .optional()
      .default([]),
    repository: z
      .object({
        id: z.string(),
        name: z.string(),
        project: z.object({ id: z.string(), name: z.string() }).passthrough(),
      })
      .passthrough(),
    forkSource: z.unknown().optional(),
    lastMergeSourceCommit: z.object({ commitId: z.string() }).passthrough().nullish(),
    autoCompleteSetBy: IdentitySchema.nullish(),
    completionOptions: CompletionOptionsSchema.nullish(),
  })
  .passthrough();

type AzurePullRequest = z.infer<typeof PullRequestSchema>;

const PullRequestListSchema = z.object({ value: z.array(PullRequestSchema) }).passthrough();

const PolicyEvaluationSchema = z
  .object({
    evaluationId: z.string().optional(),
    status: z.string().optional().default("queued"),
    configuration: z
      .object({
        isBlocking: z.boolean().optional().default(true),
        isEnabled: z.boolean().optional().default(true),
        type: z
          .object({ id: z.string(), displayName: z.string().optional().default("") })
          .passthrough(),
        settings: z.record(z.string(), z.unknown()).optional().default({}),
      })
      .passthrough(),
    context: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

type PolicyEvaluation = z.infer<typeof PolicyEvaluationSchema>;

const PolicyEvaluationListSchema = z
  .object({ value: z.array(PolicyEvaluationSchema) })
  .passthrough();

const BuildSchema = z
  .object({
    id: z.number(),
    buildNumber: z.string().optional(),
    status: z.string().optional(),
    result: z.string().nullish(),
    startTime: z.string().nullish(),
    finishTime: z.string().nullish(),
    sourceBranch: z.string().nullish(),
    sourceVersion: z.string().nullish(),
    definition: z.object({ name: z.string() }).passthrough().optional(),
  })
  .passthrough();

type AzureBuild = z.infer<typeof BuildSchema>;

const BuildListSchema = z.object({ value: z.array(BuildSchema) }).passthrough();

const TimelineRecordSchema = z
  .object({
    id: z.string(),
    parentId: z.string().nullish(),
    type: z.string(),
    name: z.string().optional().default(""),
    state: z.string().nullish(),
    result: z.string().nullish(),
    order: z.number().nullish(),
    startTime: z.string().nullish(),
    finishTime: z.string().nullish(),
    log: z.object({ id: z.number() }).passthrough().nullish(),
    issues: z
      .array(z.object({ type: z.string(), message: z.string().optional() }).passthrough())
      .nullish(),
  })
  .passthrough();

type TimelineRecord = z.infer<typeof TimelineRecordSchema>;

const TimelineSchema = z
  .object({ records: z.array(TimelineRecordSchema).optional().default([]) })
  .passthrough();

const ThreadCommentSchema = z
  .object({
    id: z.number(),
    author: IdentitySchema.optional(),
    content: z.string().nullish(),
    publishedDate: z.string().optional(),
    commentType: z.string().optional(),
    isDeleted: z.boolean().optional(),
  })
  .passthrough();

const ThreadSchema = z
  .object({
    id: z.number(),
    status: z.string().nullish(),
    isDeleted: z.boolean().optional(),
    threadContext: z
      .object({
        filePath: z.string().nullish(),
        rightFileStart: z.object({ line: z.number() }).passthrough().nullish(),
        rightFileEnd: z.object({ line: z.number() }).passthrough().nullish(),
        leftFileStart: z.object({ line: z.number() }).passthrough().nullish(),
      })
      .passthrough()
      .nullish(),
    comments: z.array(ThreadCommentSchema).optional().default([]),
    properties: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

type AzureThread = z.infer<typeof ThreadSchema>;

const ThreadListSchema = z.object({ value: z.array(ThreadSchema) }).passthrough();

const WiqlSchema = z
  .object({ workItems: z.array(z.object({ id: z.number() }).passthrough()).default([]) })
  .passthrough();

const WorkItemSchema = z
  .object({ id: z.number(), fields: z.record(z.string(), z.unknown()).default({}) })
  .passthrough();

type AzureWorkItem = z.infer<typeof WorkItemSchema>;

const WorkItemListSchema = z.object({ value: z.array(WorkItemSchema) }).passthrough();

const ConnectionDataSchema = z
  .object({ authenticatedUser: z.object({ id: z.string() }).passthrough() })
  .passthrough();

const AccessTokenSchema = z
  .object({
    accessToken: z.string(),
    expires_on: z.union([z.number(), z.string()]).optional(),
    expiresOn: z.string().optional(),
  })
  .passthrough();

function tokenExpiry(token: z.infer<typeof AccessTokenSchema>, now: number): number {
  const epoch = Number(token.expires_on);
  if (Number.isFinite(epoch) && epoch > 0) {
    return epoch * 1000;
  }
  const parsed = token.expiresOn ? Date.parse(token.expiresOn) : NaN;
  return Number.isFinite(parsed) ? parsed : now + 30 * 60_000;
}

/**
 * Bearer tokens come from `az account get-access-token`, so the daemon reuses
 * whichever identity the Azure CLI is signed in with (AZURE_CONFIG_DIR is
 * respected). A PAT in AZURE_DEVOPS_EXT_PAT, the variable the azure-devops CLI
 * extension reads, takes precedence.
 */
function createAzCredentialProvider(): (options: {
  refresh: boolean;
}) => Promise<AzureDevOpsCredential> {
  const resolveAz = createCachedCliPathResolver(() => findExecutable("az"));
  let cached: { credential: AzureDevOpsCredential; expiresAt: number; key: string } | null = null;
  let inFlight: Promise<AzureDevOpsCredential> | null = null;

  async function acquire(key: string): Promise<AzureDevOpsCredential> {
    const azPath = await resolveAz();
    if (!azPath) {
      throw new AzureDevOpsCliMissingError();
    }
    let stdout: string;
    try {
      const result = await execCommand(
        azPath,
        ["account", "get-access-token", "--resource", AZURE_DEVOPS_RESOURCE, "--output", "json"],
        { timeout: AZ_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
      stdout = result.stdout;
    } catch (error) {
      const record = (error ?? {}) as { code?: unknown; stderr?: unknown; message?: unknown };
      if (record.code === "ENOENT") {
        throw new AzureDevOpsCliMissingError();
      }
      const stderr = bufferOrStringToString(record.stderr) || String(record.message ?? "");
      throw new AzureDevOpsAuthenticationError({ stderr: stderr.trim() });
    }
    const parsed = AccessTokenSchema.safeParse(safeJsonParse(stdout));
    if (!parsed.success) {
      throw new AzureDevOpsAuthenticationError({ stderr: "az returned no access token" });
    }
    const now = Date.now();
    const credential = { authorization: `Bearer ${parsed.data.accessToken}` };
    cached = { credential, expiresAt: tokenExpiry(parsed.data, now), key };
    return credential;
  }

  return async ({ refresh }) => {
    const pat = process.env.AZURE_DEVOPS_EXT_PAT?.trim();
    if (pat) {
      return { authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}` };
    }
    const key = process.env.AZURE_CONFIG_DIR ?? "";
    if (
      !refresh &&
      cached &&
      cached.key === key &&
      cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()
    ) {
      return cached.credential;
    }
    if (!inFlight) {
      inFlight = acquire(key).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractErrorMessage(body: string): string {
  const parsed = safeJsonParse(body);
  if (parsed && typeof parsed === "object" && "message" in parsed) {
    const message = (parsed as { message?: unknown }).message;
    if (typeof message === "string" && message) {
      return message;
    }
  }
  return body.trim().slice(0, 500) || "empty response";
}

function mapPullRequestState(pr: AzurePullRequest): string {
  if (pr.status === "completed") return "merged";
  if (pr.status === "abandoned") return "closed";
  return "open";
}

function mapMergeable(mergeStatus: string | null | undefined): PullRequestMergeable {
  if (mergeStatus === "succeeded") return "MERGEABLE";
  if (mergeStatus === "conflicts") return "CONFLICTING";
  return "UNKNOWN";
}

export function deriveReviewDecision(
  reviewers: AzurePullRequest["reviewers"],
): PullRequestReviewDecision {
  if (reviewers.length === 0) return null;
  if (reviewers.some((reviewer) => reviewer.vote < 0)) return "changes_requested";
  if (reviewers.some((reviewer) => reviewer.isRequired && reviewer.vote < 5)) return "pending";
  return reviewers.some((reviewer) => reviewer.vote >= 5) ? "approved" : "pending";
}

function mapPolicyStatus(status: string): PullRequestCheckStatus {
  switch (status) {
    case "approved":
      return "success";
    case "rejected":
    case "broken":
      return "failure";
    case "notApplicable":
      return "skipped";
    default:
      return "pending";
  }
}

function isPolicyActive(policy: PolicyEvaluation): boolean {
  return policy.configuration.isEnabled;
}

function blockingPoliciesPassed(policies: PolicyEvaluation[]): boolean {
  return policies
    .filter((policy) => isPolicyActive(policy) && policy.configuration.isBlocking)
    .every((policy) => policy.status === "approved" || policy.status === "notApplicable");
}

export function allowedMergeMethods(policies: PolicyEvaluation[]): AzureDevOpsMergeMethod[] {
  const policy = policies.find(
    (entry) => isPolicyActive(entry) && entry.configuration.type.id === MERGE_STRATEGY_POLICY_TYPE,
  );
  if (!policy) {
    return ["merge", "squash", "rebase"];
  }
  const settings = policy.configuration.settings;
  const methods: AzureDevOpsMergeMethod[] = [];
  if (settings.allowNoFastForward === true) methods.push("merge");
  if (settings.allowSquash === true) methods.push("squash");
  if (settings.allowRebase === true || settings.allowRebaseMerge === true) methods.push("rebase");
  return methods.length > 0 ? methods : ["merge", "squash", "rebase"];
}

function toAzureMergeStrategy(
  method: PullRequestMergeMethod,
  policies: PolicyEvaluation[],
): string {
  if (method === "squash") return "squash";
  if (method === "merge") return "noFastForward";
  const policy = policies.find(
    (entry) => isPolicyActive(entry) && entry.configuration.type.id === MERGE_STRATEGY_POLICY_TYPE,
  );
  const settings = policy?.configuration.settings;
  if (settings && settings.allowRebase !== true && settings.allowRebaseMerge === true) {
    return "rebaseMerge";
  }
  return "rebase";
}

function formatDuration(start: string | null | undefined, end: string | null | undefined) {
  const startMs = parseOptionalTime(start ?? undefined);
  if (!startMs) return undefined;
  const endMs = parseOptionalTime(end ?? undefined) || Date.now();
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function settingString(settings: Record<string, unknown>, key: string): string | null {
  const value = settings[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function contextNumber(
  context: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const value = context?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildPolicyCheck(
  repo: AzureDevOpsRepository,
  policy: PolicyEvaluation,
  builds: Map<number, AzureBuild>,
): PullRequestCheck {
  const settings = policy.configuration.settings;
  const buildId = contextNumber(policy.context, "buildId");
  const build = buildId === null ? undefined : builds.get(buildId);
  const contextName = policy.context?.buildDefinitionName;
  const check: PullRequestCheck = {
    name:
      settingString(settings, "displayName") ??
      build?.definition?.name ??
      (typeof contextName === "string" && contextName ? contextName : null) ??
      `Build ${String(settings.buildDefinitionId ?? "")}`.trim(),
    status: mapPolicyStatus(policy.status),
    url: buildId === null ? null : buildWebUrl(repo, buildId),
    workflow: "Azure Pipelines",
  };
  // An expired validation build must be queued again before the PR can complete;
  // retention may already have deleted it, so it has no details to open.
  if (policy.context?.isExpired === true) {
    check.traits = [CHECK_TRAIT_ACTION_REQUIRED];
    return check;
  }
  const duration = build ? formatDuration(build.startTime, build.finishTime) : undefined;
  if (duration) check.duration = duration;
  if (buildId !== null) {
    check.checkRunId = buildId;
    check.workflowRunId = buildId;
  }
  return check;
}

function statusPolicyCheck(policy: PolicyEvaluation): PullRequestCheck {
  const settings = policy.configuration.settings;
  const genre = settingString(settings, "statusGenre");
  const statusName = settingString(settings, "statusName") ?? policy.configuration.type.displayName;
  return {
    name:
      settingString(settings, "defaultDisplayName") ??
      (genre ? `${genre}/${statusName}` : statusName),
    status: mapPolicyStatus(policy.status),
    url: null,
  };
}

export function toPullRequestChecks(
  repo: AzureDevOpsRepository,
  policies: PolicyEvaluation[],
  builds: Map<number, AzureBuild>,
): PullRequestCheck[] {
  const checks: PullRequestCheck[] = [];
  for (const policy of policies) {
    if (!isPolicyActive(policy)) continue;
    const typeId = policy.configuration.type.id;
    let check: PullRequestCheck;
    if (typeId === BUILD_POLICY_TYPE) {
      check = buildPolicyCheck(repo, policy, builds);
    } else if (typeId === STATUS_POLICY_TYPE) {
      check = statusPolicyCheck(policy);
    } else {
      continue;
    }
    if (!policy.configuration.isBlocking && check.status === "failure") {
      check.traits = [...(check.traits ?? []), CHECK_TRAIT_WARNING];
    }
    checks.push(check);
  }
  return checks;
}

function toPullRequestSummary(
  repo: AzureDevOpsRepository,
  pr: AzurePullRequest,
): PullRequestSummary {
  return {
    number: pr.pullRequestId,
    title: pr.title,
    url: pullRequestWebUrl(repo, pr.pullRequestId),
    state: mapPullRequestState(pr),
    body: pr.description ?? null,
    projectPath: `${repo.organization}/${repo.project}/${repo.repository}`,
    baseRefName: stripRefsHeads(pr.targetRefName),
    headRefName: stripRefsHeads(pr.sourceRefName),
    labels: pr.labels.filter((label) => label.active !== false).map((label) => label.name),
    updatedAt: pr.closedDate ?? pr.creationDate ?? "",
  };
}

export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|h[1-6]|tr|ul|ol)[^>]*>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fieldString(item: AzureWorkItem, field: string): string | null {
  const value = item.fields[field];
  return typeof value === "string" ? value : null;
}

function toIssueSummary(repo: AzureDevOpsRepository, item: AzureWorkItem): IssueSummary {
  const state = fieldString(item, "System.State") ?? "";
  const type = fieldString(item, "System.WorkItemType");
  const title = fieldString(item, "System.Title") ?? `Work item ${item.id}`;
  const tags = fieldString(item, "System.Tags");
  return {
    number: item.id,
    title: type ? `${type}: ${title}` : title,
    url: workItemWebUrl(repo, item.id),
    state: CLOSED_WORK_ITEM_STATES.has(state.toLowerCase()) ? "closed" : "open",
    body: stripHtml(fieldString(item, "System.Description")) || null,
    projectPath: `${repo.organization}/${repo.project}`,
    labels: tags
      ? tags
          .split(";")
          .map((tag) => tag.trim())
          .filter(Boolean)
      : [],
    updatedAt: fieldString(item, "System.ChangedDate") ?? "",
  };
}

function propertyValue(thread: AzureThread, key: string): unknown {
  const entry = thread.properties?.[key];
  if (entry && typeof entry === "object" && "$value" in entry) {
    return (entry as { $value: unknown }).$value;
  }
  return undefined;
}

function voteItem(thread: AzureThread, url: string): PullRequestTimelineItem | null {
  const vote = Number(propertyValue(thread, "CodeReviewVoteResult"));
  const comment = thread.comments[0];
  if (!comment || !Number.isFinite(vote) || vote === 0) return null;
  return {
    kind: "review",
    id: `vote-${thread.id}`,
    author: comment.author?.displayName ?? "",
    authorUrl: null,
    avatarUrl: null,
    body: "",
    createdAt: parseOptionalTime(comment.publishedDate),
    url,
    reviewState: vote > 0 ? "approved" : "changes_requested",
  };
}

function threadLocation(
  thread: AzureThread,
  isResolved: boolean,
): PullRequestTimelineCommentLocation | null {
  const context = thread.threadContext;
  const path = context?.filePath?.replace(/^\/+/, "");
  if (!path) return null;
  const location: PullRequestTimelineCommentLocation = {
    path,
    threadId: String(thread.id),
    isResolved,
  };
  const start = context?.rightFileStart?.line ?? context?.leftFileStart?.line;
  const end = context?.rightFileEnd?.line ?? start;
  if (end) location.line = end;
  if (start && end && end !== start) location.startLine = start;
  return location;
}

function commentItems(thread: AzureThread, url: string): PullRequestTimelineItem[] {
  const isResolved = RESOLVED_THREAD_STATES.has((thread.status ?? "").toLowerCase());
  const location = threadLocation(thread, isResolved);
  const items: PullRequestTimelineItem[] = [];
  for (const comment of thread.comments) {
    const body = (comment.content ?? "").trim();
    if (comment.isDeleted || comment.commentType === "system" || !body) continue;
    items.push({
      kind: "comment",
      id: `comment-${thread.id}-${comment.id}`,
      author: comment.author?.displayName ?? "",
      authorUrl: null,
      avatarUrl: null,
      body,
      createdAt: parseOptionalTime(comment.publishedDate),
      url,
      threadId: String(thread.id),
      threadIsResolved: isResolved,
      ...(location ? { location } : {}),
    });
  }
  return items;
}

export function toTimelineItems(
  repo: AzureDevOpsRepository,
  prNumber: number,
  threads: AzureThread[],
): PullRequestTimelineItem[] {
  const prUrl = pullRequestWebUrl(repo, prNumber);
  const items: PullRequestTimelineItem[] = [];
  for (const thread of threads) {
    if (thread.isDeleted) continue;
    const url = `${prUrl}?discussionId=${thread.id}`;
    if (propertyValue(thread, "CodeReviewThreadType") === "VoteUpdate") {
      const item = voteItem(thread, url);
      if (item) items.push(item);
    } else {
      items.push(...commentItems(thread, url));
    }
  }
  return items.sort(compareTimelineItems);
}

function mapRecordStatus(record: TimelineRecord): PipelineJobStatus {
  if (record.state === "inProgress") return "running";
  if (record.state === "pending") return "pending";
  switch (record.result) {
    case "succeeded":
    case "succeededWithIssues":
      return "success";
    case "failed":
      return "failed";
    case "canceled":
    case "abandoned":
      return "canceled";
    case "skipped":
      return "skipped";
    default:
      return record.state === "completed" ? "unknown" : "pending";
  }
}

function mapBuildStatus(build: AzureBuild): PipelineJobStatus {
  if (build.status === "inProgress" || build.status === "cancelling") return "running";
  if (build.status === "notStarted" || build.status === "postponed") return "pending";
  switch (build.result) {
    case "succeeded":
    case "partiallySucceeded":
      return "success";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return "unknown";
  }
}

const STAGE_STATUS_PRIORITY: PipelineJobStatus[] = [
  "failed",
  "running",
  "pending",
  "canceled",
  "success",
  "skipped",
];

function aggregateStatus(jobs: PipelineJob[]): PipelineJobStatus {
  for (const status of STAGE_STATUS_PRIORITY) {
    if (jobs.some((job) => job.status === status)) return status;
  }
  return "unknown";
}

// Single-stage YAML pipelines report their implicit stage as "__default".
function stageName(stage: TimelineRecord | null): string {
  return !stage || stage.name === "__default" ? "Build" : stage.name;
}

function byOrder(left: TimelineRecord, right: TimelineRecord): number {
  return (left.order ?? 0) - (right.order ?? 0);
}

export function toPipelineDetails(
  repo: AzureDevOpsRepository,
  build: AzureBuild,
  records: TimelineRecord[],
): PipelineDetails {
  const byId = new Map(records.map((record) => [record.id, record]));
  const stageOf = (record: TimelineRecord): TimelineRecord | null => {
    let current: TimelineRecord | undefined = record;
    const seen = new Set<string>();
    while (current?.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parentId);
      if (current?.type === "Stage") return current;
    }
    return null;
  };
  const url = buildWebUrl(repo, build.id);
  const jobs = records.filter((record) => record.type === "Job").sort(byOrder);
  const groups = new Map<string, { stage: TimelineRecord | null; jobs: PipelineJob[] }>();
  jobs.forEach((record, index) => {
    const stage = stageOf(record);
    const key = stage?.id ?? "";
    const group = groups.get(key) ?? { stage, jobs: [] };
    const status = mapRecordStatus(record);
    group.jobs.push({
      id: record.log?.id ?? index + 1,
      name: record.name,
      stage: stageName(stage),
      status,
      rawStatus: record.result ?? record.state ?? "unknown",
      url,
      allowFailure: false,
      durationSeconds:
        record.startTime && record.finishTime
          ? Math.max(
              0,
              Math.round(
                (parseOptionalTime(record.finishTime) - parseOptionalTime(record.startTime)) / 1000,
              ),
            )
          : null,
    });
    groups.set(key, group);
  });
  const stages: PipelineStage[] = [...groups.values()]
    .sort((left, right) => (left.stage?.order ?? 0) - (right.stage?.order ?? 0))
    .map((group) => ({
      name: stageName(group.stage),
      status: aggregateStatus(group.jobs),
      jobs: group.jobs,
    }));
  return {
    id: build.id,
    status: mapBuildStatus(build),
    rawStatus: build.result ?? build.status ?? "unknown",
    url,
    ref: build.sourceBranch ?? null,
    sha: build.sourceVersion ?? null,
    stages,
  };
}

function tail(text: string, limit: number): { text: string; truncated: boolean } {
  const cleaned = text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "")
        .replace(/##\[(section|group|endgroup|command)\]/g, ""),
    )
    .join("\n")
    .trim();
  return cleaned.length > limit
    ? { text: cleaned.slice(cleaned.length - limit), truncated: true }
    : { text: cleaned, truncated: false };
}

function wiqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function createAzureDevOpsService(
  options: CreateAzureDevOpsServiceOptions = {},
): ForgeService {
  const resolveRemoteUrl = options.resolveRemoteUrl ?? defaultResolveRemoteUrl;
  const getCredential = options.getCredential ?? createAzCredentialProvider();
  const doFetch: AzureDevOpsFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const userIdByOrganization = new Map<string, string>();

  async function resolveRepository(cwd: string): Promise<AzureDevOpsRepository> {
    const remoteUrl = await resolveRemoteUrl(cwd);
    const repo = remoteUrl ? parseAzureDevOpsRemote(remoteUrl) : null;
    if (!repo) {
      throw new Error("The origin remote of this workspace is not an Azure DevOps repository");
    }
    return repo;
  }

  async function send(
    method: string,
    url: string,
    body: unknown,
    accept: string,
  ): Promise<{ response: Response; text: string }> {
    for (const refresh of [false, true]) {
      const credential = await getCredential({ refresh });
      let response: Response;
      try {
        response = await doFetch(url, {
          method,
          headers: {
            Authorization: credential.authorization,
            Accept: accept,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            "X-TFS-FedAuthRedirect": "Suppress",
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new AzureDevOpsRequestError({
          method,
          path: url,
          status: null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const text = await response.text();
      // A rejected credential comes back as 401, or as 203 with a sign-in page.
      if (response.status === 401 || response.status === 203) {
        if (!refresh) continue;
        throw new AzureDevOpsAuthenticationError({ stderr: extractErrorMessage(text) });
      }
      if (response.status === 403 && /TF400813|not authorized|not been materialized/i.test(text)) {
        throw new AzureDevOpsAuthenticationError({ stderr: extractErrorMessage(text) });
      }
      if (!response.ok) {
        throw new AzureDevOpsRequestError({
          method,
          path: url,
          status: response.status,
          message: extractErrorMessage(text),
        });
      }
      return { response, text };
    }
    throw new AzureDevOpsAuthenticationError({ stderr: "credential rejected" });
  }

  function buildUrl(
    base: string,
    path: string,
    query: Record<string, string | number | undefined>,
  ) {
    const url = new URL(`${base}/${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    if (!url.searchParams.has("api-version")) url.searchParams.set("api-version", API_VERSION);
    return url.toString();
  }

  async function requestJson<T>(params: {
    repo: Pick<AzureDevOpsRepository, "organization">;
    method?: string;
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    schema: z.ZodType<T>;
  }): Promise<T> {
    const method = params.method ?? "GET";
    const url = buildUrl(organizationUrl(params.repo), params.path, params.query ?? {});
    const { text } = await send(method, url, params.body, "application/json");
    const parsed = params.schema.safeParse(safeJsonParse(text));
    if (!parsed.success) {
      throw new AzureDevOpsRequestError({
        method,
        path: url,
        status: null,
        message: `unexpected response: ${parsed.error.message}`,
      });
    }
    return parsed.data;
  }

  async function requestText(params: {
    repo: Pick<AzureDevOpsRepository, "organization">;
    path: string;
  }): Promise<string> {
    const url = buildUrl(organizationUrl(params.repo), params.path, {});
    const { text } = await send("GET", url, undefined, "text/plain");
    return text;
  }

  function getPullRequestById(repo: AzureDevOpsRepository, number: number) {
    return requestJson({
      repo,
      path: `${repositoryApiPath(repo)}/pullrequests/${number}`,
      schema: PullRequestSchema,
    });
  }

  async function listPullRequestsRaw(
    repo: AzureDevOpsRepository,
    query: Record<string, string | number | undefined>,
  ): Promise<AzurePullRequest[]> {
    const result = await requestJson({
      repo,
      path: `${repositoryApiPath(repo)}/pullrequests`,
      query,
      schema: PullRequestListSchema,
    });
    return result.value;
  }

  async function listPolicyEvaluations(
    repo: AzureDevOpsRepository,
    pr: AzurePullRequest,
  ): Promise<PolicyEvaluation[]> {
    const result = await requestJson({
      repo,
      path: `${encodeURIComponent(repo.project)}/_apis/policy/evaluations`,
      query: {
        artifactId: `vstfs:///CodeReview/CodeReviewId/${pr.repository.project.id}/${pr.pullRequestId}`,
        "api-version": POLICY_API_VERSION,
      },
      schema: PolicyEvaluationListSchema,
    });
    return result.value;
  }

  async function listBuilds(
    repo: AzureDevOpsRepository,
    ids: number[],
  ): Promise<Map<number, AzureBuild>> {
    if (ids.length === 0) return new Map();
    const result = await requestJson({
      repo,
      path: `${encodeURIComponent(repo.project)}/_apis/build/builds`,
      query: { buildIds: ids.join(",") },
      schema: BuildListSchema,
    });
    return new Map(result.value.map((build) => [build.id, build]));
  }

  async function loadPullRequestState(repo: AzureDevOpsRepository, number: number) {
    const pr = await getPullRequestById(repo, number);
    const policies = await listPolicyEvaluations(repo, pr);
    return { pr, policies };
  }

  function toStatusFacts(
    pr: AzurePullRequest,
    policies: PolicyEvaluation[],
  ): AzureDevOpsStatusFacts {
    return {
      status: pr.status,
      mergeStatus: pr.mergeStatus ?? null,
      isDraft: pr.isDraft,
      autoCompleteEnabled: Boolean(
        pr.autoCompleteSetBy?.id && pr.autoCompleteSetBy.id !== EMPTY_GUID,
      ),
      blockingPoliciesPassed: blockingPoliciesPassed(policies),
      allowedMethods: allowedMergeMethods(policies),
    };
  }

  async function currentUserId(repo: AzureDevOpsRepository): Promise<string> {
    const cached = userIdByOrganization.get(repo.organization);
    if (cached) return cached;
    const data = await requestJson({
      repo,
      path: "_apis/connectionData",
      query: { "api-version": "7.1-preview" },
      schema: ConnectionDataSchema,
    });
    userIdByOrganization.set(repo.organization, data.authenticatedUser.id);
    return data.authenticatedUser.id;
  }

  function updatePullRequest(repo: AzureDevOpsRepository, number: number, body: unknown) {
    return requestJson({
      repo,
      method: "PATCH",
      path: `${repositoryApiPath(repo)}/pullrequests/${number}`,
      body,
      schema: PullRequestSchema,
    });
  }

  function assertMethodAllowed(method: PullRequestMergeMethod, policies: PolicyEvaluation[]) {
    if (!allowedMergeMethods(policies).includes(method)) {
      throw new Error(`The branch policy does not allow the ${method} merge strategy`);
    }
  }

  async function searchPullRequests(input: ListPullRequestsOptions): Promise<PullRequestSummary[]> {
    const repo = await resolveRepository(input.cwd);
    const query = input.query?.trim() ?? "";
    const limit = input.limit ?? 30;
    const numberQuery = /^\d+$/.test(query) ? Number(query) : null;
    const [byNumber, active] = await Promise.all([
      numberQuery !== null
        ? getPullRequestById(repo, numberQuery).catch(() => null)
        : Promise.resolve(null),
      listPullRequestsRaw(repo, { "searchCriteria.status": "active", $top: 100 }),
    ]);
    const needle = query.toLowerCase();
    const matches = active.filter(
      (pr) =>
        !needle ||
        pr.title.toLowerCase().includes(needle) ||
        stripRefsHeads(pr.sourceRefName).toLowerCase().includes(needle),
    );
    const items = byNumber
      ? [byNumber, ...matches.filter((pr) => pr.pullRequestId !== byNumber.pullRequestId)]
      : matches;
    return items.slice(0, limit).map((pr) => toPullRequestSummary(repo, pr));
  }

  async function searchWorkItems(input: ListIssuesOptions): Promise<IssueSummary[]> {
    const repo = await resolveRepository(input.cwd);
    const query = input.query?.trim() ?? "";
    const limit = Math.min(input.limit ?? 30, 200);
    const clauses = ["[System.TeamProject] = @project", "[System.State] <> 'Removed'"];
    if (/^\d+$/.test(query)) {
      clauses.push(`([System.Id] = ${query} OR [System.Title] CONTAINS '${query}')`);
    } else if (query) {
      clauses.push(`[System.Title] CONTAINS '${wiqlLiteral(query)}'`);
    }
    const wiql = await requestJson({
      repo,
      method: "POST",
      path: `${encodeURIComponent(repo.project)}/_apis/wit/wiql`,
      query: { $top: limit },
      body: {
        query: `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(" AND ")} ORDER BY [System.ChangedDate] DESC`,
      },
      schema: WiqlSchema,
    });
    const ids = wiql.workItems.slice(0, limit).map((item) => item.id);
    if (ids.length === 0) return [];
    const details = await requestJson({
      repo,
      path: `${encodeURIComponent(repo.project)}/_apis/wit/workitems`,
      query: {
        ids: ids.join(","),
        fields: [
          "System.Id",
          "System.Title",
          "System.State",
          "System.WorkItemType",
          "System.Tags",
          "System.ChangedDate",
          "System.Description",
        ].join(","),
      },
      schema: WorkItemListSchema,
    });
    const byId = new Map(details.value.map((item) => [item.id, item]));
    return ids
      .map((id) => byId.get(id))
      .filter((item): item is AzureWorkItem => item !== undefined)
      .map((item) => toIssueSummary(repo, item));
  }

  return {
    authProbeCanThrow: true,

    async isAuthenticated(_input: { cwd: string } & ForgeReadOptions): Promise<boolean> {
      await getCredential({ refresh: false });
      return true;
    },

    async getCurrentPullRequestStatus(input): Promise<CurrentPullRequestStatus | null> {
      const repo = await resolveRepository(input.cwd);
      const candidates = (
        await listPullRequestsRaw(repo, {
          "searchCriteria.sourceRefName": toRefsHeads(input.headRef),
          "searchCriteria.status": "all",
          $top: 20,
        })
      ).filter((pr) => !pr.forkSource && stripRefsHeads(pr.sourceRefName) === input.headRef);
      const match =
        candidates.find((pr) => pr.status === "active") ??
        candidates.find(
          (pr) =>
            input.headSha !== undefined && pr.lastMergeSourceCommit?.commitId === input.headSha,
        );
      if (!match) return null;
      const policies = await listPolicyEvaluations(repo, match).catch(() => []);
      const buildIds = policies
        .map((policy) => contextNumber(policy.context, "buildId"))
        .filter((id): id is number => id !== null);
      const builds = await listBuilds(repo, buildIds).catch(() => new Map<number, AzureBuild>());
      const checks = toPullRequestChecks(repo, policies, builds);
      return {
        number: match.pullRequestId,
        repoOwner: `${repo.organization}/${repo.project}`,
        repoName: repo.repository,
        projectPath: `${repo.organization}/${repo.project}/${repo.repository}`,
        url: pullRequestWebUrl(repo, match.pullRequestId),
        title: match.title,
        state: mapPullRequestState(match),
        baseRefName: stripRefsHeads(match.targetRefName),
        headRefName: stripRefsHeads(match.sourceRefName),
        isMerged: match.status === "completed",
        isDraft: match.isDraft,
        mergeable: mapMergeable(match.mergeStatus),
        checks,
        checksStatus: computeChecksStatus(checks),
        reviewDecision: deriveReviewDecision(match.reviewers),
        forgeSpecific: { forge: "azure-devops", ...toStatusFacts(match, policies) },
      };
    },

    async getPullRequest(input: GetPullRequestOptions): Promise<PullRequestSummary> {
      const repo = await resolveRepository(input.cwd);
      return toPullRequestSummary(repo, await getPullRequestById(repo, input.number));
    },

    async getPullRequestHeadRef(input: GetPullRequestOptions): Promise<string> {
      const repo = await resolveRepository(input.cwd);
      return stripRefsHeads((await getPullRequestById(repo, input.number)).sourceRefName);
    },

    async getPullRequestCheckoutTarget(
      input: GetPullRequestOptions,
    ): Promise<PullRequestCheckoutTarget> {
      const repo = await resolveRepository(input.cwd);
      const pr = await getPullRequestById(repo, input.number);
      const headRefName = stripRefsHeads(pr.sourceRefName);
      return {
        number: pr.pullRequestId,
        baseRefName: stripRefsHeads(pr.targetRefName),
        headRefName,
        checkoutRefs: [{ remoteName: "origin", remoteRef: `refs/heads/${headRefName}` }],
        headOwnerLogin: null,
        headRepositorySshUrl: null,
        headRepositoryUrl: null,
        isCrossRepository: Boolean(pr.forkSource),
        headRefKind: "branch",
      };
    },

    listPullRequests(input: ListPullRequestsOptions): Promise<PullRequestSummary[]> {
      return searchPullRequests(input);
    },

    listIssues(input: ListIssuesOptions): Promise<IssueSummary[]> {
      return searchWorkItems(input);
    },

    async getPullRequestTimeline(
      input: GetPullRequestTimelineOptions,
    ): Promise<PullRequestTimeline> {
      const identity = {
        prNumber: input.prNumber,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
      };
      try {
        const repo = await resolveRepository(input.cwd);
        const threads = await requestJson({
          repo,
          path: `${repositoryApiPath(repo)}/pullRequests/${input.prNumber}/threads`,
          schema: ThreadListSchema,
        });
        return {
          ...identity,
          items: toTimelineItems(repo, input.prNumber, threads.value),
          truncated: false,
          error: null,
        };
      } catch (error) {
        return { ...identity, items: [], truncated: false, error: toTimelineError(error) };
      }
    },

    async getCheckDetails(input: GetCheckDetailsOptions): Promise<CheckDetails> {
      const buildId = input.checkRunId ?? input.workflowRunId;
      if (buildId === undefined) {
        throw new Error("Azure Pipelines check details need a build id");
      }
      const repo = await resolveRepository(input.cwd);
      const projectPath = encodeURIComponent(repo.project);
      const [build, timeline] = await Promise.all([
        requestJson({
          repo,
          path: `${projectPath}/_apis/build/builds/${buildId}`,
          schema: BuildSchema,
        }),
        requestJson({
          repo,
          path: `${projectPath}/_apis/build/builds/${buildId}/timeline`,
          schema: TimelineSchema,
        }),
      ]);
      const records = timeline.records;
      const failedTasks = records.filter(
        (record) => record.type === "Task" && record.result === "failed",
      );
      const failedRecords = (
        failedTasks.length > 0
          ? failedTasks
          : records.filter((record) => record.type === "Job" && record.result === "failed")
      ).slice(0, MAX_FAILED_LOGS);
      let truncated = false;
      const failedJobs: CheckFailedJob[] = await Promise.all(
        failedRecords.map(async (record, index) => {
          const job: CheckFailedJob = {
            jobId: record.log?.id ?? index + 1,
            name: record.name,
            status: record.state ?? null,
            conclusion: record.result ?? null,
            url: buildWebUrl(repo, buildId),
          };
          if (record.finishTime) job.completedAt = record.finishTime;
          if (record.log) {
            const text = await requestText({
              repo,
              path: `${projectPath}/_apis/build/builds/${buildId}/logs/${record.log.id}`,
            }).catch(() => "");
            const result = tail(text, LOG_TAIL_CHARS);
            if (result.text) {
              job.logTail = result.text;
              job.logTruncated = result.truncated;
            }
            truncated ||= result.truncated;
          }
          return job;
        }),
      );
      const annotations: CheckAnnotation[] = records.flatMap((record) =>
        (record.issues ?? [])
          .filter((issue) => issue.type === "error" && issue.message)
          .map((issue) => ({
            title: record.name,
            message: issue.message,
            annotationLevel: "failure",
          })),
      );
      const url = buildWebUrl(repo, buildId);
      return {
        checkRunId: buildId,
        workflowRunId: buildId,
        name:
          [build.definition?.name, build.buildNumber].filter(Boolean).join(" ") ||
          `Build ${buildId}`,
        status: build.status ?? null,
        conclusion: build.result ?? null,
        url,
        detailsUrl: url,
        output: null,
        annotations,
        failedJobs,
        truncated,
        pipeline: toPipelineDetails(repo, build, records),
      };
    },

    async searchIssuesAndPrs(input: SearchIssuesAndPrsOptions): Promise<SearchResult> {
      if (input.force && !input.reason) {
        throw new Error("ForgeService forced read requires a reason");
      }
      const kinds = normalizeForgeSearchKinds(input.kinds);
      const wantIssues = kinds.includes("issue");
      const wantPrs = kinds.includes("change_request");
      const [issues, prs] = await Promise.allSettled([
        wantIssues
          ? searchWorkItems({ cwd: input.cwd, query: input.query, limit: input.limit })
          : Promise.resolve([]),
        wantPrs
          ? searchPullRequests({ cwd: input.cwd, query: input.query, limit: input.limit })
          : Promise.resolve([]),
      ]);
      const requested = [wantIssues ? issues : null, wantPrs ? prs : null].filter(
        (result) => result !== null,
      );
      const rejected = requested.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (rejected.length > 0 && rejected.length === requested.length) {
        if (rejected.some((result) => result.reason instanceof AzureDevOpsCliMissingError)) {
          return createUnavailableSearchResult("cli_missing");
        }
        if (rejected.every((result) => result.reason instanceof AzureDevOpsAuthenticationError)) {
          return createUnavailableSearchResult("unauthenticated");
        }
        throw rejected[0].reason;
      }
      const items: SearchResult["items"] = [];
      if (issues.status === "fulfilled") {
        for (const issue of issues.value) {
          items.push({ kind: "issue", ...issue, baseRefName: null, headRefName: null });
        }
      }
      if (prs.status === "fulfilled") {
        for (const pr of prs.value) {
          items.push({ kind: "change_request", ...pr });
        }
      }
      const numberQuery = /^\d+$/.test(input.query.trim()) ? Number(input.query.trim()) : null;
      items.sort((left, right) => {
        if (numberQuery !== null) {
          const order = Number(right.number === numberQuery) - Number(left.number === numberQuery);
          if (order !== 0) return order;
        }
        return parseOptionalTime(right.updatedAt) - parseOptionalTime(left.updatedAt);
      });
      return {
        items,
        featuresEnabled: true,
        authState: "authenticated",
        githubFeaturesEnabled: true,
      };
    },

    async createPullRequest(input: CreatePullRequestOptions): Promise<PullRequestCreateResult> {
      const repo = await resolveRepository(input.cwd);
      const pr = await requestJson({
        repo,
        method: "POST",
        path: `${repositoryApiPath(repo)}/pullrequests`,
        body: {
          sourceRefName: toRefsHeads(input.head),
          targetRefName: toRefsHeads(input.base),
          title: input.title,
          description: input.body ?? "",
        },
        schema: PullRequestSchema,
      });
      return { url: pullRequestWebUrl(repo, pr.pullRequestId), number: pr.pullRequestId };
    },

    async mergePullRequest(input: MergePullRequestOptions): Promise<PullRequestMergeResult> {
      const repo = await resolveRepository(input.cwd);
      const { pr, policies } = await loadPullRequestState(repo, input.prNumber);
      const facts = toStatusFacts(pr, policies);
      if (pr.status !== "active")
        throw new Error(`Pull request ${pr.pullRequestId} is ${pr.status}`);
      if (facts.isDraft) throw new Error("Publish the draft pull request before completing it");
      if (facts.autoCompleteEnabled) {
        throw new Error("Direct merge is not available because auto-complete is already set");
      }
      if (facts.mergeStatus !== "succeeded") {
        throw new Error(`Azure DevOps reports merge status ${facts.mergeStatus ?? "unknown"}`);
      }
      if (!facts.blockingPoliciesPassed) {
        throw new Error("Required branch policies have not passed yet");
      }
      if (!pr.lastMergeSourceCommit) {
        throw new Error("Azure DevOps has not computed a merge for this pull request yet");
      }
      assertMethodAllowed(input.mergeMethod, policies);
      await updatePullRequest(repo, pr.pullRequestId, {
        status: "completed",
        lastMergeSourceCommit: { commitId: pr.lastMergeSourceCommit.commitId },
        completionOptions: {
          ...pr.completionOptions,
          mergeStrategy: toAzureMergeStrategy(input.mergeMethod, policies),
          bypassPolicy: false,
        },
      });
      return { success: true };
    },

    async enablePullRequestAutoMerge(
      input: EnablePullRequestAutoMergeOptions,
    ): Promise<PullRequestAutoMergeResult> {
      const repo = await resolveRepository(input.cwd);
      const { pr, policies } = await loadPullRequestState(repo, input.prNumber);
      if (pr.status !== "active")
        throw new Error(`Pull request ${pr.pullRequestId} is ${pr.status}`);
      if (toStatusFacts(pr, policies).autoCompleteEnabled) {
        throw new Error("Auto-complete is already set for this pull request");
      }
      assertMethodAllowed(input.mergeMethod, policies);
      const userId = await currentUserId(repo);
      await updatePullRequest(repo, pr.pullRequestId, {
        autoCompleteSetBy: { id: userId },
        completionOptions: {
          ...pr.completionOptions,
          mergeStrategy: toAzureMergeStrategy(input.mergeMethod, policies),
          bypassPolicy: false,
        },
      });
      return { success: true };
    },

    async disablePullRequestAutoMerge(
      input: DisablePullRequestAutoMergeOptions,
    ): Promise<PullRequestAutoMergeResult> {
      const repo = await resolveRepository(input.cwd);
      await updatePullRequest(repo, input.prNumber, { autoCompleteSetBy: { id: EMPTY_GUID } });
      return { success: true };
    },

    invalidate(_input: { cwd: string }): void {},
  };
}

function toTimelineError(error: unknown): PullRequestTimelineError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AzureDevOpsAuthenticationError) {
    return { kind: "forbidden", message };
  }
  if (error instanceof AzureDevOpsRequestError) {
    if (error.status === 404) return { kind: "not_found", message };
    if (error.status === 401 || error.status === 403) return { kind: "forbidden", message };
  }
  return { kind: "unknown", message };
}
