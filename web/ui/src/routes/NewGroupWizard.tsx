import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ScopeGrants, SCOPE_OPTIONS } from "../components/ScopeGrants.tsx";
import {
  checkFolderAvailability,
  createGroup,
  fetchFolderSuggestion,
  type FolderAvailability,
  type VaultScope,
} from "../lib/api.ts";

type Step = "identity" | "vault" | "confirm";

const DEFAULT_VAULT_URL = "http://127.0.0.1:1940/vault/default";

export function NewGroupWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("identity");

  // Identity.
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [folderTouched, setFolderTouched] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [folderCheck, setFolderCheck] = useState<FolderAvailability | null>(null);
  const [folderChecking, setFolderChecking] = useState(false);

  // Vault.
  const [attachVault, setAttachVault] = useState(false);
  const [scope, setScope] = useState<VaultScope>("vault:read");
  const [vaultBaseUrl, setVaultBaseUrl] = useState(DEFAULT_VAULT_URL);
  const [pasteToken, setPasteToken] = useState("");
  const [tokenLabel, setTokenLabel] = useState("");

  // Submit.
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Suggest a folder slug from the name when the user hasn't typed one.
  useEffect(() => {
    if (folderTouched) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setFolder("");
      return;
    }
    let cancelled = false;
    fetchFolderSuggestion(trimmed)
      .then((slug) => {
        if (!cancelled && !folderTouched) setFolder(slug);
      })
      .catch(() => {
        // Suggestion failure is non-fatal; user can type their own.
      });
    return () => {
      cancelled = true;
    };
  }, [name, folderTouched]);

  // Debounce folder availability check.
  const folderCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!folder) {
      setFolderCheck(null);
      return;
    }
    if (folderCheckTimer.current) clearTimeout(folderCheckTimer.current);
    setFolderChecking(true);
    folderCheckTimer.current = setTimeout(async () => {
      try {
        const result = await checkFolderAvailability(folder);
        setFolderCheck(result);
      } catch (err) {
        setFolderCheck({
          slug: folder,
          valid: false,
          available: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setFolderChecking(false);
      }
    }, 250);
    return () => {
      if (folderCheckTimer.current) clearTimeout(folderCheckTimer.current);
    };
  }, [folder]);

  const identityReady =
    name.trim().length > 0 &&
    folder.length > 0 &&
    folderCheck?.valid === true &&
    folderCheck?.available === true;

  const onFolderChange = useCallback((next: string) => {
    setFolderTouched(true);
    setFolder(next);
  }, []);

  const onCreate = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await createGroup({
        name: name.trim(),
        folder,
        instructions: instructions.trim() || undefined,
        vault: attachVault
          ? {
              scope,
              vaultBaseUrl: vaultBaseUrl.trim().replace(/\/+$/, "") || DEFAULT_VAULT_URL,
              tokenLabel: tokenLabel.trim() || undefined,
              token: pasteToken.trim() || undefined,
            }
          : undefined,
      });
      navigate(`/groups/${encodeURIComponent(result.group.folder)}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <Link to="/" className="muted">← All groups</Link>
      <h2 style={{ marginTop: "0.5rem" }}>New agent group</h2>
      <WizardSteps current={step} />

      {step === "identity" && (
        <div className="section">
          <h3>Identity</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (identityReady) setStep("vault");
            }}
          >
            <div className="row">
              <label htmlFor="name">Name</label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Forge"
                autoFocus
              />
              <p className="dim">
                The display name. Folder slug is derived from this — you can override below.
              </p>
            </div>

            <div className="row">
              <label htmlFor="folder">Folder slug</label>
              <input
                id="folder"
                type="text"
                value={folder}
                onChange={(e) => onFolderChange(e.target.value)}
                placeholder="e.g. forge"
              />
              <FolderHint folder={folder} checking={folderChecking} check={folderCheck} />
            </div>

            <div className="row">
              <label htmlFor="instructions">Instructions (optional)</label>
              <textarea
                id="instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Goes into CLAUDE.local.md. Leave blank for the default."
              />
              <p className="dim">
                What the agent should know about itself. Empty = the standard scaffold.
              </p>
            </div>

            <div className="actions">
              <button type="submit" disabled={!identityReady}>Next: vault</button>
              <Link to="/" className="muted" style={{ marginLeft: "0.5rem" }}>Cancel</Link>
            </div>
          </form>
        </div>
      )}

      {step === "vault" && (
        <div className="section">
          <h3>Vault attachment</h3>
          <p className="muted">
            Attach the parachute vault now, or skip and attach later from the group's detail page.
          </p>

          <div className="row" style={{ marginTop: "0.5rem" }}>
            <label className="wizard-toggle">
              <input
                type="checkbox"
                checked={attachVault}
                onChange={(e) => setAttachVault(e.target.checked)}
              />
              <span>Attach vault now</span>
            </label>
          </div>

          {attachVault && (
            <>
              <div className="row">
                <label htmlFor="vaultBaseUrl">Vault URL</label>
                <input
                  id="vaultBaseUrl"
                  type="text"
                  value={vaultBaseUrl}
                  onChange={(e) => setVaultBaseUrl(e.target.value)}
                />
                <p className="dim">
                  Default is the local vault at <code>{DEFAULT_VAULT_URL}</code>.
                </p>
              </div>

              <div className="row">
                <label htmlFor="scope">Scope</label>
                <select
                  id="scope"
                  value={scope}
                  onChange={(e) => setScope(e.target.value as VaultScope)}
                >
                  {SCOPE_OPTIONS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <ScopeGrants scope={scope} />
              </div>

              <div className="row">
                <label htmlFor="tokenLabel">Token label</label>
                <input
                  id="tokenLabel"
                  type="text"
                  value={tokenLabel}
                  onChange={(e) => setTokenLabel(e.target.value)}
                  placeholder={`claw-${folder || "<folder>"}`}
                />
                <p className="dim">
                  Used for revocation. Default: <code>claw-{folder || "<folder>"}</code>.
                </p>
              </div>

              <div className="row">
                <label htmlFor="pasteToken">Paste an existing token (optional)</label>
                <input
                  id="pasteToken"
                  type="text"
                  value={pasteToken}
                  onChange={(e) => setPasteToken(e.target.value)}
                  placeholder="pvt_…  (leave blank to mint via the parachute CLI)"
                />
                <p className="dim">
                  When blank, the server runs <code>parachute vault tokens create</code> for you.
                </p>
              </div>
            </>
          )}

          <div className="actions" style={{ marginTop: "1rem" }}>
            <button className="secondary" onClick={() => setStep("identity")}>Back</button>
            <button onClick={() => setStep("confirm")}>Next: confirm</button>
          </div>
        </div>
      )}

      {step === "confirm" && (
        <div className="section">
          <h3>Confirm</h3>
          <div className="kv">
            <div>name</div><div>{name}</div>
            <div>folder</div><div><code>{folder}</code></div>
            <div>instructions</div>
            <div>{instructions.trim() ? <em>(custom)</em> : <span className="dim">default</span>}</div>
            <div>vault</div>
            <div>
              {attachVault ? (
                <>
                  <span className="tag">{scope}</span>{" "}
                  <code>{vaultBaseUrl.trim().replace(/\/+$/, "") || DEFAULT_VAULT_URL}</code>
                </>
              ) : (
                <span className="dim">skip — attach later</span>
              )}
            </div>
            {attachVault && (
              <>
                <div>token label</div>
                <div><code>{tokenLabel.trim() || `claw-${folder}`}</code></div>
                <div>token</div>
                <div>
                  {pasteToken.trim()
                    ? <span className="dim">using pasted token</span>
                    : <span className="dim">server will mint a fresh token</span>}
                </div>
              </>
            )}
          </div>

          {submitError && (
            <div className="error-banner" style={{ marginTop: "1rem" }}>{submitError}</div>
          )}

          <div className="actions" style={{ marginTop: "1rem" }}>
            <button className="secondary" onClick={() => setStep("vault")} disabled={submitting}>
              Back
            </button>
            <button onClick={onCreate} disabled={submitting}>
              {submitting ? "Creating…" : "Create agent group"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FolderHint({
  folder,
  checking,
  check,
}: {
  folder: string;
  checking: boolean;
  check: FolderAvailability | null;
}) {
  if (!folder) {
    return (
      <p className="dim">
        Lowercase letters, digits, and dashes; ≤ 48 chars. Becomes <code>groups/&lt;slug&gt;/</code>.
      </p>
    );
  }
  if (checking || !check) {
    return <p className="dim">Checking <code>{folder}</code>…</p>;
  }
  if (!check.valid) {
    return <p className="wizard-folder-error">{check.reason ?? "Invalid slug."}</p>;
  }
  if (!check.available) {
    return <p className="wizard-folder-error">{check.reason ?? "Already taken."}</p>;
  }
  return (
    <p className="wizard-folder-ok">
      <code>groups/{folder}/</code> is available.
    </p>
  );
}

function WizardSteps({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "identity", label: "1. Identity" },
    { key: "vault", label: "2. Vault" },
    { key: "confirm", label: "3. Confirm" },
  ];
  return (
    <ol className="wizard-steps">
      {steps.map((s) => (
        <li
          key={s.key}
          className={`wizard-step${s.key === current ? " active" : ""}`}
        >
          {s.label}
        </li>
      ))}
    </ol>
  );
}
