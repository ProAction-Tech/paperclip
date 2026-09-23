import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { heartbeatService } from "./heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();

// A legacy reviewer approves its stage from inside its own run. The policy moves
// the task to the next participant, and the route stops the reviewer's run with
// `issue_reassigned` before reassignment. That stop is the end of the
// reviewer's turn, not an interrupted action, so it must not hold the next
// participant behind a no-replay reconciliation.
(support.supported ? describe : describe.skip)("workflow handoff stop of the approving run", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("workflow-handoff-cancel-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });

  async function stopForReassignment(workflowHandoff: boolean) {
    const companyId = randomUUID(), reviewerId = randomUUID(), participantId = randomUUID();
    const issueId = randomUUID(), reviewerRunId = randomUUID(), stageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Handoff", defaultResponsibleUserId: "board",
      issuePrefix: `W${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: reviewerId, companyId, name: "Reviewer", role: "engineer", adapterType: "claude_local", status: "running" },
      { id: participantId, companyId, name: "Next reviewer", role: "engineer", adapterType: "claude_local", status: "idle" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Two-stage review", status: "in_review",
      assigneeAgentId: reviewerId });
    await db.insert(heartbeatRuns).values({ id: reviewerRunId, companyId, agentId: reviewerId,
      runtimeMode: "legacy", status: "running", startedAt: new Date(),
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: reviewerRunId }).where(eq(issues.id, issueId));

    // What the issue route does before a reassignment; the marker is set only
    // when the stopped run itself recorded the policy transition.
    const cancelled = await heartbeatService(db).cancelRun(reviewerRunId, "Cancelled before issue reassignment", {
      errorCode: "issue_reassigned",
      resultJson: { reassignmentStopConfirmed: true,
        ...(workflowHandoff ? { workflowHandoff: { runId: reviewerRunId, issueId, fromAgentId: reviewerId } } : {}) },
      eventMessage: "run cancelled before issue reassignment", eventPayload: { issueId },
    });
    expect(cancelled?.status).toBe("cancelled");
    await db.update(issues).set({ assigneeAgentId: participantId, executionRunId: null,
      executionState: { status: "pending", currentStageId: stageId, currentStageType: "review",
        currentParticipant: { type: "agent", agentId: participantId, userId: null } } })
      .where(eq(issues.id, issueId));

    // Ordinary periodic recovery.
    await heartbeatService(db).reconcileStrandedAssignedIssues();
    await settleUnrecoverableExecutions(db);
    await heartbeatService(db).reconcileStrandedAssignedIssues();
    const actions = await db.select().from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)));
    return { actions, blocker: await getExecutionBlocker(db, companyId, issueId) };
  }

  it("does not hold the next participant after the approving run stops itself", async () => {
    const { actions, blocker } = await stopForReassignment(true);
    expect(actions).toHaveLength(0);
    expect(blocker).toBeNull();
  });

  it("still holds a run stopped by a reassignment it did not record", async () => {
    const { blocker } = await stopForReassignment(false);
    expect(blocker).toMatchObject({ cause: "legacy_execution_requires_reconciliation" });
  });
});
