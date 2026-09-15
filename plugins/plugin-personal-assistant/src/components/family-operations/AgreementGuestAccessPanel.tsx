/** Named owner permission choices retain exact grant bindings and require a fresh matching preview before sharing. */
import { Button, Input, NativeSelect } from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgreementGuestAccessOptions,
  AgreementGuestGrantPreview,
} from "../../lifeops/household/agreement-knowledge.js";
import type { FamilyOperationsAdapter, Loadable } from "./types.js";

type Result =
  | { kind: "preview"; preview: AgreementGuestGrantPreview }
  | { kind: "options"; options: AgreementGuestAccessOptions };

export function AgreementGuestAccessPanel({
  artifactId,
  adapter,
}: {
  artifactId: string;
  adapter: FamilyOperationsAdapter;
}) {
  const [options, setOptions] =
    useState<Loadable<AgreementGuestAccessOptions> | null>(null);
  const [choiceId, setChoiceId] = useState("");
  const [revokeId, setRevokeId] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<AgreementGuestGrantPreview | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef(0);

  const reload = useCallback(async () => {
    const token = ++request.current;
    setBusy(true);
    setOptions(null);
    setPreview(null);
    setNotice(null);
    setError(null);
    try {
      const data = await adapter.listGuestAccessOptions(artifactId);
      if (token !== request.current) return;
      setOptions({ status: "ready", data });
      setNeedsRefresh(false);
    } catch (cause) {
      // error-policy:J1 loading failure disables permission mutations until a successful refresh.
      if (token === request.current)
        setOptions({
          status: "unavailable",
          message:
            cause instanceof Error
              ? cause.message
              : "Guest permissions could not load.",
        });
    } finally {
      if (token === request.current) setBusy(false);
    }
  }, [adapter, artifactId]);
  useEffect(() => {
    void reload();
    return () => {
      request.current += 1;
    };
  }, [reload]);

  const choice =
    options?.status === "ready"
      ? options.data.candidates.find(
          (item) => item.householdGrantId === choiceId,
        )
      : undefined;
  const revocable =
    options?.status === "ready"
      ? options.data.grants.find((item) => item.grantId === revokeId)
      : undefined;
  const matches = Boolean(
    choice &&
      preview &&
      preview.artifactId === artifactId &&
      preview.principalEntityId === choice.principalEntityId &&
      preview.householdGrantId === choice.householdGrantId,
  );
  const allowed = matches && preview?.allowed === true;

  const run = async (
    operation: () => Promise<Result>,
    success: string,
    mutation = false,
  ) => {
    const token = ++request.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    setPreview(null);
    try {
      const result = await operation();
      if (token !== request.current) return;
      if (result.kind === "preview") setPreview(result.preview);
      else setOptions({ status: "ready", data: result.options });
      setNotice(success);
    } catch (cause) {
      // error-policy:J1 unconfirmed writes require readback before another mutation can be attempted.
      if (token === request.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Guest permission operation failed.",
        );
        if (mutation) setNeedsRefresh(true);
      }
    } finally {
      if (token === request.current) setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {options === null ? (
        <p role="status">Loading guest permissions…</p>
      ) : options.status === "unavailable" ? (
        <p role="alert">{options.message}</p>
      ) : (
        <>
          {options.data.candidates.length === 0 ? (
            <p>
              No eligible guests. Add a verified household member with knowledge
              read permission, then refresh.
            </p>
          ) : (
            <>
              <label htmlFor="family-guest-permission">
                Verified guest permission
                <NativeSelect
                  id="family-guest-permission"
                  aria-label="Verified guest permission"
                  presentation="touch"
                  className="min-w-0 keyboard-focus-surface"
                  disabled={busy}
                  value={choice?.householdGrantId ?? ""}
                  onChange={(event) => {
                    setChoiceId(event.target.value);
                    setPreview(null);
                    setNotice(null);
                  }}
                >
                  <option value="">Choose a guest permission</option>
                  {options.data.candidates.map((item) => (
                    <option
                      key={item.householdGrantId}
                      value={item.householdGrantId}
                    >
                      {item.displayName ?? item.identityLabel} ·{" "}
                      {item.role.replaceAll("_", " ")} · issued{" "}
                      {new Date(item.issuedAt).toLocaleString()}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              {choice ? (
                <p>
                  {choice.identityLabel}. Issued{" "}
                  {new Date(choice.issuedAt).toLocaleString()}.{" "}
                  {choice.expiresAt
                    ? `Permission expires ${new Date(choice.expiresAt).toLocaleString()}.`
                    : "No scheduled expiry."}{" "}
                  Agreement sharing covers metadata and approved obligations
                  only.
                </p>
              ) : null}
            </>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button
              className="min-h-11"
              variant="outline"
              disabled={busy || needsRefresh || !choice}
              onClick={() =>
                void run(async () => {
                  if (!choice)
                    throw new Error("Choose a current guest permission.");
                  const result = await adapter.previewGrant({
                    artifactId,
                    principalEntityId: choice.principalEntityId,
                    householdGrantId: choice.householdGrantId,
                  });
                  if (
                    result.artifactId !== artifactId ||
                    result.principalEntityId !== choice.principalEntityId ||
                    result.householdGrantId !== choice.householdGrantId
                  ) {
                    setNeedsRefresh(true);
                    throw new Error(
                      "The permission preview did not match your selection. Refresh guest permissions before continuing.",
                    );
                  }
                  return { kind: "preview", preview: result };
                }, "Preview ready.")
              }
            >
              Preview permission
            </Button>
            <Button
              className="min-h-11"
              disabled={busy || needsRefresh || !allowed}
              onClick={() =>
                void run(
                  async () => {
                    if (!choice || !allowed)
                      throw new Error(
                        "Preview the selected guest permission first.",
                      );
                    const grant = await adapter.issueGrant({
                      artifactId,
                      principalEntityId: choice.principalEntityId,
                      householdGrantId: choice.householdGrantId,
                    });
                    const data =
                      await adapter.listGuestAccessOptions(artifactId);
                    if (
                      !data.grants.some(
                        (item) =>
                          item.grantId === grant.id &&
                          item.principalEntityId === choice.principalEntityId &&
                          item.householdGrantId === choice.householdGrantId &&
                          item.canRead,
                      )
                    )
                      throw new Error(
                        "Sharing could not be confirmed. Refresh guest permissions before retrying.",
                      );
                    return { kind: "options", options: data };
                  },
                  "Guest access enabled.",
                  true,
                )
              }
            >
              Allow access
            </Button>
          </div>
          {matches && preview ? (
            <div role="status">
              <strong>
                {preview.allowed ? "Ready to grant" : "Cannot grant"}
              </strong>
              <p>
                {preview.denial?.message ??
                  "Guest can read artifact metadata and approved obligations only."}
              </p>
              <small>
                Pins do not grant access. Proposed and rejected obligations
                remain private.
              </small>
            </div>
          ) : null}
          <div
            style={{
              borderTop: "1px solid var(--border)",
              paddingTop: 16,
              display: "grid",
              gap: 9,
            }}
          >
            <strong>Remove guest access</strong>
            {options.data.grants.length === 0 ? (
              <p>No guest access to remove.</p>
            ) : (
              <>
                <label htmlFor="family-existing-guest-access">
                  Existing guest access
                  <NativeSelect
                    id="family-existing-guest-access"
                    aria-label="Existing guest access"
                    presentation="touch"
                    className="min-w-0 keyboard-focus-surface"
                    disabled={busy}
                    value={revocable?.grantId ?? ""}
                    onChange={(event) => setRevokeId(event.target.value)}
                  >
                    <option value="">Choose existing access</option>
                    {options.data.grants.map((item) => (
                      <option key={item.grantId} value={item.grantId}>
                        {item.displayName ?? "Unavailable person"} · issued{" "}
                        {new Date(item.issuedAt).toLocaleString()}
                        {item.canRead ? "" : " · currently unavailable"}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                {revocable?.denial ? (
                  <p>
                    {revocable.denial} You can still remove this agreement
                    grant.
                  </p>
                ) : null}
              </>
            )}
            {revocable ? (
              <>
                <label htmlFor="family-revoke-reason">
                  Reason for removing access
                  <Input
                    id="family-revoke-reason"
                    className="keyboard-focus-surface"
                    aria-label="Reason for removing access"
                    value={reason}
                    disabled={busy}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                <div>
                  <Button
                    className="min-h-11"
                    variant="outline"
                    disabled={
                      busy || needsRefresh || !revocable || !reason.trim()
                    }
                    onClick={() =>
                      void run(
                        async () => {
                          if (!revocable)
                            throw new Error(
                              "Choose an existing agreement grant.",
                            );
                          await adapter.revokeGrant(revocable.grantId, reason);
                          const data =
                            await adapter.listGuestAccessOptions(artifactId);
                          if (
                            data.grants.some(
                              (item) => item.grantId === revocable.grantId,
                            )
                          )
                            throw new Error(
                              "Revocation could not be confirmed. Refresh guest permissions before retrying.",
                            );
                          return { kind: "options", options: data };
                        },
                        "Guest access removed.",
                        true,
                      )
                    }
                  >
                    Remove access
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </>
      )}
      <div>
        <Button
          className="min-h-11"
          variant="outline"
          disabled={busy}
          onClick={() => void reload()}
        >
          Refresh guest permissions
        </Button>
      </div>
      {needsRefresh ? (
        <p role="alert">
          Refresh guest permissions to confirm the current state before
          continuing.
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </div>
  );
}
