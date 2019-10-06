import { error as logError, info, warning, group } from "@actions/core";
import { GitHub } from "@actions/github";
import { Context } from "@actions/github/lib/context";
import {
  WebhookPayloadCheckRun,
  WebhookPayloadPullRequest,
  WebhookPayloadPullRequestReview,
  WebhookPayloadStatus,
} from "@octokit/webhooks";
import { PullsGetResponse } from "@octokit/rest";
import * as assert from "assert";
import promiseRetry from "promise-retry";

/**
 * See https://developer.github.com/v4/enum/mergestatestatus/
 */
type MergeableState =
  | "behind"
  | "blocked"
  | "clean"
  | "dirty"
  | "draft"
  | "unknown"
  | "unstable";

type WebhookPayload =
  | WebhookPayloadCheckRun
  | WebhookPayloadPullRequest
  | WebhookPayloadPullRequestReview
  | WebhookPayloadStatus;

const autosquashLabel = "autosquash";

const updateableMergeableStates: MergeableState[] = [
  // When "Require branches to be up to date before merging" is checked
  // and the pull request is missing commits from its base branch,
  // GitHub will consider its mergeable state to be "behind".
  "behind",
];

const potentialMergeableStates: MergeableState[] = [
  "clean",
  // When checks are running on a pull request,
  // GitHub considers its mergeable state to be "unstable".
  // It's what will happen when the Autosquash action is
  // running so we need to attempt a merge even in that case.
  "unstable",
];

const getPullRequestId = (pullRequestNumber: number) => `#${pullRequestNumber}`;

const isCandidate = ({
  closed_at,
  labels,
}: {
  closed_at: string | null;
  labels: Array<{ name: string }>;
}): boolean => {
  if (closed_at !== null) {
    info("Already merged or closed");
    return false;
  }

  if (!labels.some(({ name }) => name === autosquashLabel)) {
    info(`No ${autosquashLabel} label`);
    return false;
  }

  return true;
};

const isCandidateWithMergeableState = (
  {
    closed_at,
    labels,
    mergeable_state: actualMergeableState,
  }: PullsGetResponse,
  expectedMergeableState: MergeableState[],
): boolean => {
  if (!isCandidate({ closed_at, labels })) {
    return false;
  }

  info(`Mergeable state is ${actualMergeableState}`);
  return Array.isArray(expectedMergeableState)
    ? expectedMergeableState.includes(actualMergeableState as MergeableState)
    : actualMergeableState === expectedMergeableState;
};

const fetchPullRequest = async ({
  github,
  owner,
  pullRequestNumber,
  repo,
}: {
  github: GitHub;
  owner: string;
  pullRequestNumber: number;
  repo: string;
}) => {
  info("Fetching pull request details");
  return promiseRetry(
    async retry => {
      try {
        const { data: pullRequest } = await github.pulls.get({
          owner,
          pull_number: pullRequestNumber,
          repo,
        });
        assert(
          pullRequest.closed_at !== null ||
            (pullRequest.mergeable_state as MergeableState) !== "unknown",
        );
        return pullRequest;
      } catch (error) {
        info("Refetching details to know mergeable state");
        return retry(error);
      }
    },
    { minTimeout: 250 },
  );
};

const handlePullRequests = async ({
  github,
  handle,
  owner,
  pullRequestNumbers,
  repo,
}: {
  github: GitHub;
  handle: (pullRequest: PullsGetResponse) => Promise<unknown>;
  owner: string;
  pullRequestNumbers: number[];
  repo: string;
}) =>
  Promise.all(
    pullRequestNumbers.map(async pullRequestNumber =>
      group(`Handling ${getPullRequestId(pullRequestNumber)}`, async () => {
        const pullRequest = await fetchPullRequest({
          github,
          owner,
          pullRequestNumber,
          repo,
        });
        await handle(pullRequest);
      }),
    ),
  );

const handleSearchedPullRequests = async ({
  github,
  handle,
  owner,
  query,
  repo,
}: {
  github: GitHub;
  handle: (pullRequest: PullsGetResponse) => Promise<unknown>;
  owner: string;
  query: string;
  repo: string;
}) => {
  const fullQuery = `is:pr is:open label:"${autosquashLabel}" repo:${owner}/${repo} ${query}`;
  const {
    data: { incomplete_results, items },
  } = await github.search.issuesAndPullRequests({
    order: "asc",
    q: fullQuery,
    sort: "created",
  });
  if (incomplete_results) {
    warning(
      `Search has incomplete results, only the first ${items.length} items will be handled`,
    );
  }

  await Promise.all(
    items.map(async item =>
      group(
        `Handling searched pull request ${getPullRequestId(item.number)}`,
        async () => {
          if (isCandidate(item)) {
            const pullRequest = await fetchPullRequest({
              github,
              owner,
              pullRequestNumber: item.number,
              repo,
            });
            await handle(pullRequest);
          }
        },
      ),
    ),
  );
};

const merge = async ({
  github,
  owner,
  pullRequest: {
    head: { sha },
    number: pull_number,
  },
  repo,
}: {
  github: GitHub;
  owner: string;
  pullRequest: PullsGetResponse;
  repo: string;
}) => {
  try {
    info("Attempting merge");
    await github.pulls.merge({
      merge_method: "squash",
      owner,
      pull_number,
      repo,
      sha,
    });
    info("Merged!");
  } catch (error) {
    logError(`Merge failed: ${error.message}`);
  }
};

const update = async ({
  github,
  owner,
  pullRequest: {
    head: { sha: expected_head_sha },
    number: pull_number,
  },
  repo,
}: {
  github: GitHub;
  owner: string;
  pullRequest: PullsGetResponse;
  repo: string;
}) => {
  try {
    info("Attempting update");
    await github.pulls.updateBranch({
      expected_head_sha,
      owner,
      pull_number,
      repo,
    });
    info("Updated!");
  } catch (error) {
    logError(`Update failed: ${error.message}`);
  }
};

const autosquash = async ({
  context,
  github,
}: {
  context: Context;
  github: GitHub;
}) => {
  const { eventName } = context;
  const {
    repository: {
      name: repo,
      owner: { login: owner },
    },
  } = context.payload as WebhookPayload;

  if (eventName === "check_run") {
    const payload = context.payload as WebhookPayloadCheckRun;
    if (payload.action === "completed") {
      const pullRequestNumbers = payload.check_run.pull_requests.map(
        ({ number }) => number,
      );
      info(`Consider merging ${pullRequestNumbers.map(getPullRequestId)}`);
      await handlePullRequests({
        github,
        async handle(pullRequest) {
          if (
            isCandidateWithMergeableState(pullRequest, potentialMergeableStates)
          ) {
            await merge({
              github,
              owner,
              pullRequest,
              repo,
            });
          }
        },
        owner,
        pullRequestNumbers,
        repo,
      });
    }
  } else if (eventName === "pull_request") {
    const payload = context.payload as WebhookPayloadPullRequest;
    if (payload.action === "closed" && payload.pull_request.merged) {
      const {
        pull_request: {
          base: { ref: base },
        },
      } = payload;
      info(`Update all relevant pull requests on base ${base}`);
      await handleSearchedPullRequests({
        github,
        async handle(pullRequest) {
          if (
            isCandidateWithMergeableState(
              pullRequest,
              updateableMergeableStates,
            )
          ) {
            await update({
              github,
              owner,
              pullRequest,
              repo,
            });
          }
        },
        owner,
        query: `base:"${base}"`,
        repo,
      });
    } else if (
      payload.action === "labeled" &&
      // The payload has a label property when the action is "labeled".
      // @ts-ignore
      payload.label.name === autosquashLabel
    ) {
      info(`Consider merging or updating ${getPullRequestId(payload.number)}`);
      const pullRequest = await fetchPullRequest({
        github,
        owner,
        pullRequestNumber: payload.number,
        repo,
      });
      if (
        isCandidateWithMergeableState(pullRequest, [
          ...updateableMergeableStates,
          ...potentialMergeableStates,
        ])
      ) {
        const handle = updateableMergeableStates.includes(
          pullRequest.mergeable_state as MergeableState,
        )
          ? update
          : merge;
        await handle({ github, owner, pullRequest, repo });
      }
    }
  } else if (eventName === "pull_request_review") {
    const payload = context.payload as WebhookPayloadPullRequestReview;
    if (payload.action === "submitted" && payload.review.state === "approved") {
      const pullRequestNumber = payload.pull_request.number;
      info(`Consider merging ${getPullRequestId(pullRequestNumber)}`);
      const pullRequest = await fetchPullRequest({
        github,
        owner,
        pullRequestNumber,
        repo,
      });
      if (
        isCandidateWithMergeableState(pullRequest, potentialMergeableStates)
      ) {
        await merge({
          github,
          owner,
          pullRequest,
          repo,
        });
      }
    }
  } else if (eventName === "status") {
    const payload = context.payload as WebhookPayloadStatus;
    if (payload.state === "success") {
      info(`Merge all pull requests on commit ${payload.sha}`);
      await handleSearchedPullRequests({
        github,
        async handle(pullRequest) {
          if (
            isCandidateWithMergeableState(pullRequest, potentialMergeableStates)
          ) {
            const actualHeadSha = pullRequest.head.sha;
            if (actualHeadSha === payload.sha) {
              await merge({
                github,
                owner,
                pullRequest,
                repo,
              });
            } else {
              info(`Skipping since HEAD is actually ${actualHeadSha}`);
            }
          }
        },
        owner,
        query: payload.sha,
        repo,
      });
    }
  }
};

export { autosquash };