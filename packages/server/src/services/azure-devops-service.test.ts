import { describe, expect, it } from "vitest";

import {
  AzureDevOpsAuthenticationError,
  createAzureDevOpsService,
  deriveReviewDecision,
  parseAzureDevOpsRemote,
  type AzureDevOpsFetch,
} from "./azure-devops-service.js";
import { defaultForgeRegistry } from "./forge-registry.js";

const REMOTE = "https://acme@dev.azure.com/acme/Platform%20Team/_git/infra";
const ORG = "https://dev.azure.com/acme";
const REPO_PATH = `${ORG}/Platform%20Team/_apis/git/repositories/infra`;

interface Route {
  method?: string;
  match: (url: URL) => boolean;
  status?: number;
  body: unknown;
}

function fakeFetch(routes: Route[], calls: { method: string; url: URL; body?: unknown }[] = []) {
  const fetch: AzureDevOpsFetch = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    const method = init.method ?? "GET";
    calls.push({
      method,
      url,
      ...(typeof init.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    const route = routes.find(
      (candidate) => (candidate.method ?? "GET") === method && candidate.match(url),
    );
    if (!route) {
      return new Response(JSON.stringify({ message: `no route for ${method} ${rawUrl}` }), {
        status: 404,
      });
    }
    const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(body, { status: route.status ?? 200 });
  };
  return { fetch, calls };
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    pullRequestId: 42,
    status: "active",
    title: "Add network module",
    description: "Body",
    sourceRefName: "refs/heads/feat/network",
    targetRefName: "refs/heads/main",
    isDraft: false,
    mergeStatus: "succeeded",
    creationDate: "2026-10-01T10:00:00Z",
    reviewers: [{ id: "r1", displayName: "Rita", vote: 10, isRequired: true }],
    labels: [{ name: "infra", active: true }],
    repository: {
      id: "repo-id",
      name: "infra",
      project: { id: "project-id", name: "Platform Team" },
    },
    lastMergeSourceCommit: { commitId: "abc123" },
    autoCompleteSetBy: null,
    completionOptions: { deleteSourceBranch: true },
    ...overrides,
  };
}

const buildPolicy = {
  status: "approved",
  configuration: {
    isBlocking: true,
    isEnabled: true,
    type: { id: "0609b952-1397-4640-95ec-e00a01b2c241", displayName: "Build" },
    settings: { buildDefinitionId: 7, displayName: null },
  },
  context: { buildId: 900 },
};

const mergeStrategyPolicy = {
  status: "approved",
  configuration: {
    isBlocking: true,
    isEnabled: true,
    type: { id: "fa4e907d-c16b-4a4c-9dfa-4916e5d171ab", displayName: "Require a merge strategy" },
    settings: { allowSquash: true, allowNoFastForward: false, allowRebase: false },
  },
};

function service(routes: Route[], calls?: { method: string; url: URL; body?: unknown }[]) {
  return createAzureDevOpsService({
    resolveRemoteUrl: async () => REMOTE,
    getCredential: async () => ({ authorization: "Bearer test" }),
    fetch: fakeFetch(routes, calls).fetch,
  });
}

describe("parseAzureDevOpsRemote", () => {
  it.each([
    [REMOTE, { organization: "acme", project: "Platform Team", repository: "infra" }],
    [
      "git@ssh.dev.azure.com:v3/acme/Platform%20Team/infra",
      { organization: "acme", project: "Platform Team", repository: "infra" },
    ],
    [
      "https://acme.visualstudio.com/DefaultCollection/Platform/_git/infra",
      { organization: "acme", project: "Platform", repository: "infra" },
    ],
    [
      "acme@vs-ssh.visualstudio.com:v3/acme/Platform/infra",
      { organization: "acme", project: "Platform", repository: "infra" },
    ],
    [
      "https://dev.azure.com/acme/_git/infra",
      { organization: "acme", project: "infra", repository: "infra" },
    ],
  ])("parses %s", (remote, expected) => {
    expect(parseAzureDevOpsRemote(remote)).toEqual(expected);
  });

  it.each(["https://github.com/acme/infra.git", "https://dev.azure.com/acme/Platform/infra"])(
    "rejects %s",
    (remote) => {
      expect(parseAzureDevOpsRemote(remote)).toBeNull();
    },
  );

  it("is the registered adapter for Azure DevOps hosts", () => {
    expect(defaultForgeRegistry.matchHost("dev.azure.com")).toBe("azure-devops");
    expect(defaultForgeRegistry.matchHost("ssh.dev.azure.com")).toBe("azure-devops");
    expect(defaultForgeRegistry.matchHost("acme.visualstudio.com")).toBe("azure-devops");
    expect(defaultForgeRegistry.matchHost("visualstudio.com.evil.example")).toBeNull();
  });
});

describe("deriveReviewDecision", () => {
  it("waits for required reviewers and surfaces rejections", () => {
    expect(deriveReviewDecision([])).toBeNull();
    expect(
      deriveReviewDecision([
        { displayName: "A", vote: 10, isRequired: false },
        { displayName: "B", vote: 0, isRequired: true },
      ]),
    ).toBe("pending");
    expect(deriveReviewDecision([{ displayName: "A", vote: -5, isRequired: false }])).toBe(
      "changes_requested",
    );
    expect(deriveReviewDecision([{ displayName: "A", vote: 5, isRequired: true }])).toBe(
      "approved",
    );
  });
});

describe("createAzureDevOpsService", () => {
  it("reports the active pull request of the branch with policy checks", async () => {
    const forge = service([
      {
        match: (url) =>
          url.href.startsWith(`${REPO_PATH}/pullrequests?`) &&
          url.searchParams.get("searchCriteria.sourceRefName") === "refs/heads/feat/network",
        body: {
          value: [pullRequest({ pullRequestId: 41, status: "completed" }), pullRequest()],
        },
      },
      {
        match: (url) => url.pathname.endsWith("/_apis/policy/evaluations"),
        body: { value: [buildPolicy, mergeStrategyPolicy] },
      },
      {
        match: (url) =>
          url.pathname.endsWith("/_apis/build/builds") &&
          url.searchParams.get("buildIds") === "900",
        body: {
          value: [
            {
              id: 900,
              definition: { name: "infra-ci" },
              startTime: "2026-10-01T10:00:00Z",
              finishTime: "2026-10-01T10:02:05Z",
            },
          ],
        },
      },
    ]);

    const status = await forge.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/network",
      headSha: "def456",
    });

    expect(status).toMatchObject({
      number: 42,
      url: "https://dev.azure.com/acme/Platform%20Team/_git/infra/pullrequest/42",
      state: "open",
      baseRefName: "main",
      headRefName: "feat/network",
      mergeable: "MERGEABLE",
      checksStatus: "success",
      reviewDecision: "approved",
      checks: [
        {
          name: "infra-ci",
          status: "success",
          duration: "2m 5s",
          checkRunId: 900,
          url: "https://dev.azure.com/acme/Platform%20Team/_build/results?buildId=900",
        },
      ],
      forgeSpecific: {
        forge: "azure-devops",
        mergeStatus: "succeeded",
        autoCompleteEnabled: false,
        blockingPoliciesPassed: true,
        allowedMethods: ["squash"],
      },
    });
  });

  it("attaches a completed pull request only when its head matches HEAD", async () => {
    const routes: Route[] = [
      {
        match: (url) => url.href.startsWith(`${REPO_PATH}/pullrequests?`),
        body: { value: [pullRequest({ status: "completed" })] },
      },
      { match: (url) => url.pathname.endsWith("/_apis/policy/evaluations"), body: { value: [] } },
    ];
    const forge = service(routes);
    await expect(
      forge.getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feat/network",
        headSha: "other",
      }),
    ).resolves.toBeNull();
    await expect(
      forge.getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feat/network",
        headSha: "abc123",
      }),
    ).resolves.toMatchObject({ number: 42, state: "merged", isMerged: true });
  });

  it("completes a pull request with the allowed strategy and refuses others", async () => {
    const calls: { method: string; url: URL; body?: unknown }[] = [];
    const forge = service(
      [
        {
          match: (url) => url.href.startsWith(`${REPO_PATH}/pullrequests/42?`),
          body: pullRequest(),
        },
        {
          method: "PATCH",
          match: (url) => url.href.startsWith(`${REPO_PATH}/pullrequests/42?`),
          body: pullRequest({ status: "completed" }),
        },
        {
          match: (url) => url.pathname.endsWith("/_apis/policy/evaluations"),
          body: { value: [buildPolicy, mergeStrategyPolicy] },
        },
      ],
      calls,
    );

    await expect(
      forge.mergePullRequest({ cwd: "/repo", prNumber: 42, mergeMethod: "merge" }),
    ).rejects.toThrow(/does not allow the merge/);
    await forge.mergePullRequest({ cwd: "/repo", prNumber: 42, mergeMethod: "squash" });

    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.body).toEqual({
      status: "completed",
      lastMergeSourceCommit: { commitId: "abc123" },
      completionOptions: { deleteSourceBranch: true, mergeStrategy: "squash", bypassPolicy: false },
    });
  });

  it("maps review threads and vote updates onto the timeline", async () => {
    const forge = service([
      {
        match: (url) => url.pathname.endsWith("/pullRequests/42/threads"),
        body: {
          value: [
            {
              id: 1,
              status: "fixed",
              threadContext: {
                filePath: "/main.bicep",
                rightFileStart: { line: 3 },
                rightFileEnd: { line: 5 },
              },
              comments: [
                {
                  id: 1,
                  author: { displayName: "Rita" },
                  content: "Pin the version",
                  publishedDate: "2026-10-01T11:00:00Z",
                  commentType: "text",
                },
              ],
            },
            {
              id: 2,
              properties: {
                CodeReviewThreadType: { $value: "VoteUpdate" },
                CodeReviewVoteResult: { $value: "10" },
              },
              comments: [
                {
                  id: 1,
                  author: { displayName: "Rita" },
                  content: "Rita voted 10",
                  publishedDate: "2026-10-01T12:00:00Z",
                  commentType: "system",
                },
              ],
            },
          ],
        },
      },
    ]);

    const timeline = await forge.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 42,
      repoOwner: "acme/Platform Team",
      repoName: "infra",
    });

    expect(timeline.error).toBeNull();
    expect(timeline.items).toMatchObject([
      {
        kind: "comment",
        body: "Pin the version",
        threadIsResolved: true,
        location: { path: "main.bicep", line: 5, startLine: 3 },
      },
      { kind: "review", reviewState: "approved", author: "Rita" },
    ]);
  });

  it("retries once with a fresh credential and then reports sign-in", async () => {
    const refreshes: boolean[] = [];
    const forge = createAzureDevOpsService({
      resolveRemoteUrl: async () => REMOTE,
      getCredential: async ({ refresh }) => {
        refreshes.push(refresh);
        return { authorization: "Bearer expired" };
      },
      fetch: fakeFetch([{ match: () => true, status: 203, body: "<html>Sign in</html>" }]).fetch,
    });

    await expect(forge.getPullRequest({ cwd: "/repo", number: 42 })).rejects.toBeInstanceOf(
      AzureDevOpsAuthenticationError,
    );
    expect(refreshes).toEqual([false, true]);
  });
});
