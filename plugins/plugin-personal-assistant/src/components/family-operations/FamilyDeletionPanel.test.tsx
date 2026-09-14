/** Exercises deletion review, uncertain mutation recovery, and duplicate admission through the real React panel. */
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  FamilyBackupCleanupReview,
  FamilyDeletionJob,
  FamilyDeletionPreview,
} from "../../lifeops/family-workflows/deletion-contracts.js";
import type { FamilyDeletionAdapter } from "./deletion-adapter.js";
import { FamilyDeletionPanel } from "./FamilyDeletionPanel.js";

afterEach(cleanup);
function preview(sha256 = "a".repeat(64)): FamilyDeletionPreview {
  return {
    agentId: "agent",
    sha256,
    unavailable: [],
    records: [
      {
        kind: "agreements",
        classification: "owned",
        unsettled: false,
        sha256: "c".repeat(64),
        identity: { id: "agreement", title: "Parenting plan" },
      },
      {
        kind: "calendar",
        classification: "referenced",
        unsettled: false,
        sha256: "d".repeat(64),
        identity: { id: "provider-calendar" },
      },
    ],
  };
}
function job(state: FamilyDeletionJob["state"]): FamilyDeletionJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    agentId: "agent",
    reviewedSha256: "a".repeat(64),
    startedAt: "2026-09-13T12:00:00.000Z",
    state,
    backupRetention: "7-days",
    backupGeneration: "22222222-2222-4222-8222-222222222222",
    backupOperationId: "family-delete",
    files: [],
    databaseRowsRemoved: 2,
    retained: [{ kind: "calendar", count: 1 }],
  };
}
function backupReview(): FamilyBackupCleanupReview {
  return {
    jobId: job("backup_pending").id,
    generation: job("backup_pending").backupGeneration,
    notBefore: "2026-09-20T12:00:00.000Z",
    sha256: "e".repeat(64),
    archives: [
      {
        fileName: "synthetic.agent-backup.json",
        archiveSha256: "f".repeat(64),
        stateSha256: "a".repeat(64),
        restoreGeneration: "initial",
        createdAt: "2026-09-01T12:00:00.000Z",
        sizeBytes: 100,
      },
    ],
  };
}
function adapter(): FamilyDeletionAdapter {
  return {
    preview: vi.fn(async () => preview()),
    status: vi.fn(async () => null),
    begin: vi.fn(async () => job("backup_pending")),
    resume: vi.fn(async () => job("backup_pending")),
    previewBackups: vi.fn(async () => backupReview()),
    admitBackups: vi.fn(async () => ({
      ...job("backup_pending"),
      backupCleanup: backupReview(),
    })),
    resumeBackups: vi.fn(async () => ({
      ...job("complete"),
      backupCleanup: backupReview(),
    })),
  };
}
async function open() {
  fireEvent.click(
    screen.getByRole("button", { name: "Review workspace deletion" }),
  );
  await screen.findByRole("button", { name: "Delete reviewed workspace" });
}
function confirm() {
  fireEvent.click(screen.getByRole("button", { name: "After 7 days" }));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Delete reviewed workspace" }),
  );
}
it("requires a fresh complete review and binds confirmation to the refreshed snapshot after rejection", async () => {
  const api = adapter();
  vi.mocked(api.begin).mockRejectedValueOnce(
    new Error("Workspace changed; review again"),
  );
  render(<FamilyDeletionPanel adapter={api} onChange={async () => {}} />);
  await open();
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Delete reviewed workspace",
    }).disabled,
  ).toBe(true);
  confirm();
  await screen.findByRole("alert");
  expect(
    screen.queryByRole("button", { name: "Delete reviewed workspace" }),
  ).toBeNull();
  vi.mocked(api.preview).mockResolvedValue(preview("b".repeat(64)));
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh deletion status" }),
  );
  await screen.findByRole("checkbox");
  expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(false);
  confirm();
  await screen.findByText(
    /Backup cleanup is pending; deletion is not complete/,
  );
  expect(api.begin).toHaveBeenLastCalledWith({
    expectedSha256: "b".repeat(64),
    backupRetention: "7-days",
  });
});
it("does not dispatch while dependency review is incomplete or work is unsettled", async () => {
  const api = adapter();
  const incomplete = preview();
  incomplete.unavailable = ["agreements"];
  incomplete.records[0].unsettled = true;
  vi.mocked(api.preview).mockResolvedValue(incomplete);
  render(<FamilyDeletionPanel adapter={api} onChange={async () => {}} />);
  await open();
  confirm();
  expect(api.begin).not.toHaveBeenCalled();
  expect(screen.getByText(/Review is incomplete/)).toBeTruthy();
  expect(screen.getByText(/Work is still in progress/)).toBeTruthy();
});
it("prevents duplicate admission and reloads the durable pending job for recovery", async () => {
  const api = adapter();
  let settle: (value: FamilyDeletionJob) => void = () => {
    throw new Error("request not started");
  };
  vi.mocked(api.begin).mockImplementation(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  const mounted = render(
    <FamilyDeletionPanel adapter={api} onChange={async () => {}} />,
  );
  await open();
  confirm();
  fireEvent.click(
    screen.getByRole("button", { name: "Delete reviewed workspace" }),
  );
  expect(api.begin).toHaveBeenCalledTimes(1);
  settle(job("purge_pending"));
  await screen.findByText(/Primary-file cleanup is still pending/);
  mounted.unmount();
  vi.mocked(api.status).mockResolvedValue(job("purge_pending"));
  vi.mocked(api.resume).mockRejectedValueOnce(
    new Error("Cleanup acknowledgement lost"),
  );
  render(<FamilyDeletionPanel adapter={api} onChange={async () => {}} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Review workspace deletion" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry primary cleanup" }),
  );
  await screen.findByText("Cleanup acknowledgement lost");
  fireEvent.click(
    screen.getByRole("button", { name: "Retry primary cleanup" }),
  );
  await screen.findByText(
    /Backup cleanup is pending; deletion is not complete/,
  );
  await waitFor(() => expect(api.resume).toHaveBeenCalledTimes(2));
  expect(api.begin).toHaveBeenCalledTimes(1);
});

it("requires separate whole-archive acknowledgement and discards a stale backup review", async () => {
  const api = adapter();
  vi.mocked(api.status).mockResolvedValue(job("backup_pending"));
  vi.mocked(api.admitBackups).mockRejectedValueOnce(
    new Error("Archive inventory changed"),
  );
  render(
    <FamilyDeletionPanel adapter={api} onChange={async () => undefined} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Review workspace deletion" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Review backup copies" }),
  );
  const confirmButton = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Confirm reviewed backup cleanup",
  });
  expect(confirmButton.disabled).toBe(true);
  fireEvent.click(screen.getByText("Review all 1 backup copies"));
  expect(screen.getByText(/synthetic.agent-backup.json/)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(confirmButton);
  await screen.findByText("Archive inventory changed");
  expect(api.admitBackups).toHaveBeenCalledWith({
    expectedSha256: backupReview().sha256,
    acknowledgeWholeArchiveHistory: true,
  });
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review backup copies" }));
  expect((await screen.findByRole<HTMLInputElement>("checkbox")).checked).toBe(
    false,
  );
});

it("shows retained admission without completing early and recovers completion after a lost acknowledgement", async () => {
  const api = adapter();
  const admitted = { ...job("backup_pending"), backupCleanup: backupReview() };
  vi.mocked(api.status).mockResolvedValue(admitted);
  vi.mocked(api.resumeBackups).mockRejectedValueOnce(
    new Error("Cleanup acknowledgement lost"),
  );
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse("2026-09-19T12:00:00.000Z"));
  try {
    render(
      <FamilyDeletionPanel adapter={api} onChange={async () => undefined} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review workspace deletion" }),
    );
    const retry = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Retry backup cleanup",
    });
    expect(retry.disabled).toBe(true);
    expect(api.resumeBackups).not.toHaveBeenCalled();
    clock.mockReturnValue(Date.parse("2026-09-21T12:00:00.000Z"));
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh deletion status" }),
    );
    await waitFor(() => expect(retry.disabled).toBe(false));
    fireEvent.click(retry);
    await screen.findByText("Cleanup acknowledgement lost");
    expect(screen.queryByText(/Workspace deletion is complete/)).toBeNull();
    vi.mocked(api.status).mockResolvedValue({ ...admitted, state: "complete" });
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh deletion status" }),
    );
    await screen.findByText(/Workspace deletion is complete/);
    expect(
      screen.queryByRole("button", { name: "Retry backup cleanup" }),
    ).toBeNull();
  } finally {
    clock.mockRestore();
  }
});
