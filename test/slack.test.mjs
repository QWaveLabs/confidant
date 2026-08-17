import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FileStateStore,
  SimulatedDesktopVaultAdapter,
  SimulatedEnvironmentAdapter,
  SimulatedObsidianAdapter,
  SimulatedSlackOfficialPlugin,
  approveSlackBlockedGroupException,
  authorizeSlackOfficialPlugin,
  beginSlackConnection,
  fetchApprovedSourceContent,
  fetchApprovedSlackContent,
  getSlackConnectionStatus,
  grantSlackContent,
  grantSourcePermission,
  requestSlackBlockedGroupException,
  startSetupSession
} from "../src/index.mjs";

const accountId = "slack-workspace";
const clock = { now: () => new Date("2026-08-17T12:00:00.000Z") };

function slackFixture() {
  const people = [
    { id: "allowed-alex", label: "Alex Example", accessLevel: "allowed" },
    { id: "allowed-blair", label: "Blair Example", accessLevel: "allowed" },
    { id: "restricted-riley", label: "Riley Example", accessLevel: "restricted" },
    { id: "blocked-morgan", label: "Morgan Example", accessLevel: "blocked" }
  ];
  const metadataPages = [
    [
      {
        id: "channel-product-root",
        kind: "item",
        area: "channels",
        channel: "channel-product",
        visibility: "public",
        category: "work",
        timestamp: "2026-08-16T10:00:00.000Z",
        participantIds: ["allowed-alex"],
        threadId: "thread-product-root",
        label: "Product planning title must not leave the plugin seam",
        body: "Raw Slack source text must never leave the plugin seam."
      },
      {
        id: "channel-product-blair",
        kind: "item",
        area: "channels",
        channel: "channel-product",
        visibility: "public",
        category: "work",
        timestamp: "2026-08-16T10:30:00.000Z",
        participantIds: ["allowed-blair"],
        threadId: "thread-product-blair",
        label: "Another raw channel title",
        body: "This is also a raw message body."
      },
      {
        id: "direct-alex",
        kind: "conversation",
        area: "direct-messages",
        conversation: "direct-alex",
        category: "work",
        timestamp: "2026-08-16T11:00:00.000Z",
        participantIds: ["allowed-alex"],
        label: "Direct-message title",
        body: "Private direct-message fixture body."
      },
      {
        id: "group-blocked",
        kind: "conversation",
        area: "group-messages",
        conversation: "group-blocked",
        category: "work",
        timestamp: "2026-08-16T11:15:00.000Z",
        isGroup: true,
        participantIds: ["allowed-alex", "blocked-morgan"],
        label: "Blocked group title",
        body: "Blocked-person group fixture body."
      }
    ],
    [
      {
        id: "channel-ops-root",
        kind: "item",
        area: "channels",
        channel: "channel-ops",
        visibility: "public",
        category: "work",
        timestamp: "2026-08-16T12:00:00.000Z",
        participantIds: ["allowed-alex"],
        threadId: "thread-ops-root",
        label: "Operations root",
        body: "Raw operations root."
      },
      {
        id: "channel-ops-reply",
        kind: "item",
        area: "channels",
        channel: "channel-ops",
        visibility: "public",
        category: "work",
        timestamp: "2026-08-16T12:05:00.000Z",
        participantIds: ["allowed-alex"],
        threadId: "thread-ops-reply",
        threadRootId: "thread-ops-root",
        label: "Operations reply",
        body: "Raw operations reply."
      },
      {
        id: "group-allowed",
        kind: "conversation",
        area: "group-messages",
        conversation: "group-allowed",
        category: "work",
        timestamp: "2026-08-16T12:10:00.000Z",
        isGroup: true,
        participantIds: ["allowed-alex", "allowed-blair"],
        label: "Allowed group title",
        body: "Allowed group fixture body."
      },
      {
        id: "direct-restricted",
        kind: "conversation",
        area: "direct-messages",
        conversation: "direct-restricted",
        category: "work",
        timestamp: "2026-08-16T12:15:00.000Z",
        participantIds: ["restricted-riley"],
        label: "Restricted direct-message title",
        body: "Restricted direct fixture body."
      },
      {
        id: "out-of-window",
        kind: "item",
        area: "channels",
        channel: "channel-product",
        visibility: "public",
        category: "work",
        timestamp: "2026-04-01T12:00:00.000Z",
        participantIds: ["allowed-alex"],
        threadId: "thread-old",
        label: "Old title",
        body: "Old fixture body."
      },
      {
        id: "private-channel-item",
        kind: "item",
        area: "channels",
        channel: "private-legal",
        category: "work",
        timestamp: "2026-08-16T13:00:00.000Z",
        participantIds: ["allowed-alex"],
        threadId: "thread-private",
        visibility: "private",
        label: "Confidential legal channel title",
        body: "Private-channel fixture body."
      },
      {
        id: "unknown-visibility-channel-item",
        kind: "item",
        area: "channels",
        channel: "unclassified-channel",
        category: "work",
        timestamp: "2026-08-16T13:05:00.000Z",
        participantIds: ["allowed-alex"],
        threadId: "thread-unclassified",
        label: "Unclassified channel title",
        body: "An unknown channel visibility must fail closed."
      }
    ]
  ];
  return { account: { id: accountId, label: "Customer workspace label" }, people, metadataPages };
}

async function withSlackFixture(run, { language = "en", pluginOptions = {} } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa148-"));
  const stateStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));
  const adapters = {
    environment: new SimulatedEnvironmentAdapter(),
    obsidian: new SimulatedObsidianAdapter(),
    vault: new SimulatedDesktopVaultAdapter()
  };
  const plugin = new SimulatedSlackOfficialPlugin({ ...slackFixture(), ...pluginOptions });
  try {
    await startSetupSession({
      message: language === "es" ? "Configura mi segundo cerebro" : "Set up my second brain",
      answers: { displayName: "Alex", focus: "prepare for the week" },
      decisions: { vaultName: "My Second Brain" },
      stateStore,
      adapters,
      clock
    });
    await run({ directory, stateStore, plugin });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function approvedScope(permissionReview) {
  const scope = structuredClone(permissionReview.permissionRequest.requestedScope);
  scope.acknowledgements.modelProcessing = true;
  scope.acknowledgements.untrustedSourceMaterial = true;
  return scope;
}

async function beginAndAuthorize({ stateStore, plugin, language = "en", reviewId = "slack-review" }) {
  await beginSlackConnection({
    message: language === "es" ? "Quiero conectar Slack a mi segundo cerebro" : "Please connect Slack to my second brain",
    stateStore,
    accountId,
    language,
    clock
  });
  return authorizeSlackOfficialPlugin({
    message: language === "es" ? "Apruebo el flujo de Slack de solo lectura" : "I approve the read-only Slack plugin flow",
    stateStore,
    plugin,
    accountId,
    pluginAuthorizationApproved: true,
    language,
    clock,
    reviewIdFactory: () => reviewId
  });
}

test("Slack authorization is explicit, verification is read-only, and metadata pagination stays body-free", async () => {
  await withSlackFixture(async ({ stateStore, plugin }) => {
    const offered = await beginSlackConnection({
      message: "Please connect Slack to my second brain",
      stateStore,
      accountId,
      clock
    });
    assert.equal(offered.slack.status, "selected-but-unfinished");
    assert.equal(offered.slack.phase, "awaiting-plugin-authorization");
    assert.equal(offered.slack.connection.live, false);
    assert.equal(plugin.authorizationRequests, 0);
    assert.equal(plugin.readOnlyVerificationCalls, 0);
    assert.equal(plugin.metadataDiscoveryAttempts, 0);
    assert.equal(plugin.bodyFetchCalls, 0);

    const stillAwaiting = await authorizeSlackOfficialPlugin({
      message: "I want to continue Slack setup",
      stateStore,
      plugin,
      accountId,
      pluginAuthorizationApproved: false,
      clock
    });
    assert.equal(stillAwaiting.slack.phase, "awaiting-plugin-authorization");
    assert.equal(plugin.authorizationRequests, 0);
    assert.equal(plugin.metadataDiscoveryAttempts, 0);

    const reviewed = await beginAndAuthorize({ stateStore, plugin });
    assert.equal(plugin.authorizationRequests, 1);
    assert.equal(plugin.readOnlyVerificationCalls, 1);
    assert.equal(plugin.metadataPreflightCalls, 1);
    assert.equal(plugin.metadataDiscoveryAttempts, 1);
    assert.equal(plugin.bodyFetchCalls, 0);
    assert.equal(plugin.bodyAccesses, 0);
    assert.equal(plugin.writeCalls, 0);
    assert.equal(reviewed.slack.connection.verifiedReadOnly, true);
    assert.equal(reviewed.slack.connection.canPost, false);
    assert.equal(reviewed.slack.connection.canReact, false);
    assert.equal(reviewed.slack.connection.canEdit, false);
    assert.equal(reviewed.slack.connection.canArchive, false);
    assert.equal(reviewed.slack.connection.canInvite, false);
    assert.equal(reviewed.slack.connection.canChangeWorkspaceState, false);
    assert.equal(reviewed.slack.metadata.pagination.status, "complete");
    assert.deepEqual(reviewed.slack.metadata.pagination, { status: "complete", pagesReviewed: 2, pagesExpected: 2 });
    assert.equal(reviewed.slack.metadata.privateChannels.count, 2);
    assert.equal(reviewed.slack.permissionReview.metadataPreflight.contentBodiesRead, false);
    assert.equal(reviewed.slack.permissionReview.permissionRequest.requestedScope.dateRange.pastDays, 90);
    assert.equal(reviewed.slack.privacy.channelBoundary, "independently-enforceable");
    assert.equal(reviewed.slack.privacy.directMessageBoundary, "independently-enforceable");
    assert.equal(reviewed.slack.privacy.groupMessageBoundary, "independently-enforceable");
    assert.equal(reviewed.slack.privacy.peopleBoundary, "independently-enforceable");
    assert.equal(reviewed.slack.privacy.dateBoundary, "independently-enforceable");

    const safeOutput = JSON.stringify(reviewed);
    assert.equal(safeOutput.includes("private-legal"), false);
    assert.equal(safeOutput.includes("unclassified-channel"), false);
    assert.equal(safeOutput.includes("Customer workspace label"), false);
    assert.equal(safeOutput.includes("Raw Slack source text"), false);
    assert.equal(safeOutput.includes("Confidential legal channel title"), false);
  });
});

test("channel, direct-message, group-message, people, and date boundaries are independently enforced before stable references are exposed", async () => {
  await withSlackFixture(async ({ stateStore, plugin }) => {
    const reviewed = await beginAndAuthorize({ stateStore, plugin, reviewId: "independent-boundaries" });
    const reviewId = reviewed.slack.permissionReview.permissionRequest.reviewId;
    const scope = approvedScope(reviewed.slack.permissionReview);
    scope.areas = ["channels", "direct-messages"];
    scope.channels = ["channel-product"];
    scope.conversations = ["direct-alex"];
    scope.people.allowed = ["allowed-alex"];
    scope.exclusions.areas = ["group-messages"];

    const granted = await grantSlackContent({
      message: "Approve only the selected Slack channel and direct-message scope",
      stateStore,
      plugin,
      accountId,
      reviewId,
      scope,
      clock,
      grantIdFactory: () => "independent-grant"
    });
    assert.equal(granted.slack.phase, "ready-to-process");

    const fetched = await fetchApprovedSlackContent({
      message: "Process only my approved Slack references",
      stateStore,
      plugin,
      accountId,
      reviewId,
      clock
    });
    assert.equal(fetched.slack.phase, "processed-simulated");
    assert.deepEqual(fetched.approvedThreads.map((reference) => reference.sourceRecordId).sort(), ["channel-product-root", "direct-alex"]);
    assert.equal(fetched.approvedThreads.some((reference) => reference.sourceRecordId === "channel-product-blair"), false, "an omitted Allowed person is structurally excluded");
    assert.equal(fetched.approvedThreads.some((reference) => reference.sourceRecordId === "group-allowed"), false, "group-message area is independently excluded");
    assert.equal(fetched.approvedThreads.some((reference) => reference.sourceRecordId === "out-of-window"), false, "the default 90-day boundary is enforced");
    assert.equal(fetched.approvedThreads.some((reference) => reference.sourceRecordId === "private-channel-item"), false, "private channels never enter the review");
    assert.deepEqual(fetched.approvedThreads[0].threadContext, {
      conversationId: "channel-product",
      threadId: "thread-product-root",
      parentThreadId: null
    });
    assert.equal(fetched.approvedThreads[0].stableReference, "slack:slack-workspace:channel-product:thread-product-root");
    assert.equal("body" in fetched.approvedThreads[0], false);
    assert.equal("label" in fetched.approvedThreads[0], false);
    assert.equal("title" in fetched.approvedThreads[0], false);
    assert.equal(plugin.writeCalls, 0);
  });
});

test("a blocked person in a group is skipped by default and can enter only after a separate one-group review", async () => {
  await withSlackFixture(async ({ stateStore, plugin }) => {
    const reviewed = await beginAndAuthorize({ stateStore, plugin, reviewId: "blocked-group-content-review" });
    const reviewId = reviewed.slack.permissionReview.permissionRequest.reviewId;
    const scope = approvedScope(reviewed.slack.permissionReview);
    scope.blockedGroupConversationExceptions = ["group-blocked"];

    await assert.rejects(
      () => grantSlackContent({
        message: "Approve the Slack scope including the blocked group",
        stateStore,
        plugin,
        accountId,
        reviewId,
        scope,
        clock
      }),
      /separate, explicit review/i
    );
    assert.equal(plugin.bodyFetchCalls, 0);

    // The connector has its own pre-fetch policy check, so using the generic
    // grant API cannot bypass the separate Slack group-review step.
    await grantSourcePermission({
      message: "Approve the reviewed Slack scope directly for this contract test",
      stateStore,
      connector: plugin,
      source: "slack",
      accountId,
      reviewId,
      scope,
      clock,
      grantIdFactory: () => "generic-blocked-group-grant"
    });
    await assert.rejects(
      () => fetchApprovedSourceContent({
        message: "Fetch the direct generic Slack contract result",
        stateStore,
        connector: plugin,
        source: "slack",
        accountId,
        reviewId,
        clock
      }),
      /not separately approved/i
    );
    assert.equal(plugin.bodyFetchCalls, 0);

    const requested = await requestSlackBlockedGroupException({
      message: "I want to review this one Slack group separately",
      stateStore,
      accountId,
      reviewId,
      conversationId: "group-blocked",
      clock,
      blockedGroupReviewIdFactory: () => "blocked-group-review"
    });
    assert.match(requested.message, /blocked person/i);
    assert.equal(requested.slack.privacy.blockedGroupReviews[0].status, "awaiting-customer-confirmation");

    const waiting = await approveSlackBlockedGroupException({
      message: "Continue reviewing that one group",
      stateStore,
      accountId,
      reviewId,
      conversationId: "group-blocked",
      blockedGroupReviewId: "blocked-group-review",
      explicitlyApproved: false,
      clock
    });
    assert.equal(waiting.slack.privacy.blockedGroupReviews[0].status, "awaiting-customer-confirmation");

    const approved = await approveSlackBlockedGroupException({
      message: "I explicitly approve this one blocked Slack group",
      stateStore,
      accountId,
      reviewId,
      conversationId: "group-blocked",
      blockedGroupReviewId: "blocked-group-review",
      explicitlyApproved: true,
      clock
    });
    assert.equal(approved.slack.privacy.blockedGroupReviews[0].status, "approved");

    await grantSlackContent({
      message: "Approve the separately reviewed Slack group scope",
      stateStore,
      plugin,
      accountId,
      reviewId,
      scope,
      clock,
      grantIdFactory: () => "blocked-group-grant"
    });
    const fetched = await fetchApprovedSlackContent({
      message: "Process only the separately approved Slack references",
      stateStore,
      plugin,
      accountId,
      reviewId,
      clock
    });
    assert.equal(fetched.approvedThreads.some((reference) => reference.sourceRecordId === "group-blocked"), true);
    assert.equal(fetched.approvedThreads.some((reference) => reference.sourceRecordId === "direct-restricted"), false);
    assert.equal(plugin.blockedGroupPolicyCalls, 1, "the connector receives the separately persisted one-group policy before fetching");
    const reply = fetched.approvedThreads.find((reference) => reference.sourceRecordId === "channel-ops-reply");
    assert.deepEqual(reply.threadContext, {
      conversationId: "channel-ops",
      threadId: "thread-ops-reply",
      parentThreadId: "thread-ops-root"
    });
    assert.equal(plugin.writeCalls, 0);
  });
});

test("incomplete pagination and private-channel attempts stay truthful, body-free, and resumable", async () => {
  await withSlackFixture(async ({ stateStore, plugin }) => {
    plugin.paginationState = "incomplete";
    const incomplete = await beginAndAuthorize({ stateStore, plugin, reviewId: "pagination-review" });
    assert.equal(incomplete.metadataReviewUnavailable, true);
    assert.equal(incomplete.slack.status, "needs-attention");
    assert.equal(incomplete.slack.phase, "metadata-review-unavailable");
    assert.equal(incomplete.slack.metadata.pagination.status, "incomplete");
    assert.equal(incomplete.slack.metadata.pagination.pagesReviewed, 1);
    assert.equal(plugin.metadataPreflightCalls, 0);
    assert.equal(plugin.bodyFetchCalls, 0);
    assert.equal(plugin.bodyAccesses, 0);

    plugin.paginationState = "complete";
    const resumed = await authorizeSlackOfficialPlugin({
      message: "Please retry the saved Slack metadata review",
      stateStore,
      plugin,
      accountId,
      pluginAuthorizationApproved: true,
      clock,
      reviewIdFactory: () => "pagination-recovered"
    });
    assert.equal(resumed.slack.phase, "awaiting-content-grant");
    assert.equal(resumed.slack.metadata.pagination.status, "complete");
    assert.equal(plugin.bodyFetchCalls, 0);
    const scope = approvedScope(resumed.slack.permissionReview);
    scope.channels.push("private-legal");
    await assert.rejects(
      () => grantSlackContent({
        message: "Approve the private Slack channel too",
        stateStore,
        plugin,
        accountId,
        reviewId: "pagination-recovered",
        scope,
        clock
      }),
      /not part of the metadata review/i
    );
    assert.equal(plugin.bodyFetchCalls, 0);
    assert.equal(JSON.stringify(resumed).includes("private-legal"), false);
  });
});

test("revoked plugin access deactivates the local grant and never masquerades as a live connection", async () => {
  await withSlackFixture(async ({ stateStore, plugin }) => {
    const reviewed = await beginAndAuthorize({ stateStore, plugin, reviewId: "revoked-review" });
    const reviewId = reviewed.slack.permissionReview.permissionRequest.reviewId;
    await grantSlackContent({
      message: "Approve the reviewed Slack scope",
      stateStore,
      plugin,
      accountId,
      reviewId,
      scope: approvedScope(reviewed.slack.permissionReview),
      clock,
      grantIdFactory: () => "revoked-grant"
    });
    plugin.authorizationState = "revoked";
    const unavailable = await fetchApprovedSlackContent({
      message: "Process my approved Slack references",
      stateStore,
      plugin,
      accountId,
      reviewId,
      clock
    });
    assert.equal(unavailable.importUnavailable, true);
    assert.equal(unavailable.slack.status, "revoked");
    assert.equal(unavailable.slack.connection.live, false);
    assert.deepEqual(unavailable.approvedThreads, []);
    assert.equal(plugin.bodyFetchCalls, 0);
    assert.equal(plugin.bodyAccesses, 0);
    assert.ok(plugin.grantRevocationCalls >= 1, "the local simulated grant is deactivated without a Slack write");
    assert.equal(plugin.writeCalls, 0);

    const saved = await getSlackConnectionStatus({ stateStore, accountId });
    assert.equal(saved.slack.status, "revoked");
    assert.match(saved.slack.message, /revoked/i);
  });

  await withSlackFixture(async ({ stateStore, plugin }) => {
    await beginSlackConnection({
      message: "Please connect Slack to my second brain",
      stateStore,
      accountId,
      clock
    });
    plugin.requestOfficialPluginAuthorization = async () => {
      const error = new Error("The provider reported a revoked grant.");
      error.code = "SLACK_AUTHORIZATION_REVOKED";
      throw error;
    };
    const revokedAtAuthorization = await authorizeSlackOfficialPlugin({
      message: "I approve the Slack plugin flow",
      stateStore,
      plugin,
      accountId,
      pluginAuthorizationApproved: true,
      clock
    });
    assert.equal(revokedAtAuthorization.slack.status, "revoked");
    assert.equal(plugin.metadataDiscoveryAttempts, 0);
    assert.equal(plugin.bodyFetchCalls, 0);
  });
});

test("a malformed stable-reference response fails closed after the approved opaque fetch", async () => {
  await withSlackFixture(async ({ stateStore, plugin }) => {
    const reviewed = await beginAndAuthorize({ stateStore, plugin, reviewId: "malformed-reference-review" });
    const reviewId = reviewed.slack.permissionReview.permissionRequest.reviewId;
    await grantSlackContent({
      message: "Approve the reviewed Slack scope",
      stateStore,
      plugin,
      accountId,
      reviewId,
      scope: approvedScope(reviewed.slack.permissionReview),
      clock,
      grantIdFactory: () => "malformed-reference-grant"
    });
    plugin.normalizeStableThreadReferences = async ({ records }) => records.map((record) => ({
      sourceRecordId: record.sourceRecordId,
      conversationType: "channel-thread",
      stableReference: "unsafe-source-link",
      threadContext: { conversationId: "channel-product", threadId: "thread-product-root", parentThreadId: null },
      body: "Injected raw workspace dump must not reach the public result."
    }));

    const failed = await fetchApprovedSlackContent({
      message: "Process my approved Slack references",
      stateStore,
      plugin,
      accountId,
      reviewId,
      clock
    });
    assert.equal(failed.importUnavailable, true);
    assert.equal(failed.slack.status, "needs-attention");
    assert.deepEqual(failed.approvedThreads, []);
    assert.equal(JSON.stringify(failed).includes("Injected raw workspace dump"), false);
    assert.ok(plugin.grantRevocationCalls >= 1);
    assert.equal(plugin.writeCalls, 0);
  });
});

test("authorization denial resumes safely, and Spanish preserves the same official-plugin and privacy truth", async () => {
  await withSlackFixture(async ({ stateStore, plugin }) => {
    plugin.authorizationState = "denied";
    await beginSlackConnection({
      message: "Quiero conectar Slack a mi segundo cerebro",
      stateStore,
      accountId,
      language: "es",
      clock
    });
    const denied = await authorizeSlackOfficialPlugin({
      message: "Apruebo iniciar el flujo de Slack",
      stateStore,
      plugin,
      accountId,
      pluginAuthorizationApproved: true,
      language: "es",
      clock
    });
    assert.equal(denied.slack.status, "skipped");
    assert.match(denied.slack.message, /No se concedió autorización/i);
    assert.equal(plugin.metadataDiscoveryAttempts, 0);
    assert.equal(plugin.bodyFetchCalls, 0);

    plugin.authorizationState = "authorized";
    const resumed = await authorizeSlackOfficialPlugin({
      message: "Quiero reintentar Slack ahora",
      stateStore,
      plugin,
      accountId,
      pluginAuthorizationApproved: true,
      language: "es",
      clock,
      reviewIdFactory: () => "spanish-slack-review"
    });
    assert.equal(resumed.slack.phase, "awaiting-content-grant");
    assert.match(resumed.slack.message, /únicamente metadatos/i);
    assert.match(resumed.slack.metadata.privateChannels.message, /canales privados/i);
    assert.match(resumed.slack.privacy.blockedGroupMessage, /persona bloqueada/i);
    assert.equal(resumed.slack.connection.live, false);
    assert.equal(plugin.bodyFetchCalls, 0);
  }, { language: "es" });
});
