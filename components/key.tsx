"use client";

// Pide la clave de Comfy del visitante y explica cómo sacarla. La clave se guarda solo en su navegador
// (sesión, o este equipo si lo pide) y viaja al servidor únicamente para enviar sus trabajos.

import { useEffect, useState } from "react";

export type KeyReason = "need_key" | "invalid_key" | "no_credits" | "manage";
const STORE = "oev.comfyKey";

export function loadKey() {
  try { return localStorage.getItem(STORE) ?? sessionStorage.getItem(STORE) ?? ""; } catch { return ""; }
}
function saveKey(key: string, remember: boolean) {
  try {
    localStorage.removeItem(STORE); sessionStorage.removeItem(STORE);
    if (key) (remember ? localStorage : sessionStorage).setItem(STORE, key);
  } catch { /* sin almacenamiento: la clave vive mientras la pestaña siga abierta */ }
}

const KEYS_URL = "https://platform.comfy.org/profile/api-keys";

type Balance = { available: number | null; cloud: number | null; pending: number | null };
const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Saldo de la cuenta de una clave. Comfy no documenta este dato, así que si falla simplemente no se muestra. */
async function fetchBalance(key: string): Promise<Balance | "invalid" | null> {
  try {
    const r = await fetch("/api/balance", { headers: { "x-comfy-key": key } });
    if (r.status === 401) return "invalid";
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const TITLES: Record<KeyReason, string> = {
  need_key: "Connect your Comfy account",
  manage: "Your Comfy API key",
  invalid_key: "That key didn't work",
  no_credits: "Your Comfy account is out of credits",
};

export function KeyDialog({ reason, hasKey, onSave, onClose }: {
  reason: KeyReason; hasKey: boolean; onSave: (key: string) => void; onClose: () => void;
}) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [current, setCurrent] = useState<Balance | null>(null);
  useEffect(() => {
    const saved = loadKey();
    if (saved) fetchBalance(saved).then((b) => { if (b && b !== "invalid") setCurrent(b); });
  }, []);
  // Antes de guardar, se pregunta a Comfy por el saldo: así se sabe al instante si la clave sirve.
  const submit = async () => {
    const k = key.trim(); if (!k) return;
    setChecking(true); setProblem(null);
    const b = await fetchBalance(k);
    setChecking(false);
    if (b === "invalid") { setProblem("Comfy didn't accept this key. Check that you copied all of it."); return; }
    saveKey(k, remember); onSave(k);
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="key-title" onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <form className="sheet" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2 id="key-title">{TITLES[reason]}</h2>
        {reason === "invalid_key" && <p className="alert">Comfy rejected the key. Check that you copied all of it, or create a new one.</p>}
        {reason === "no_credits" && <p className="alert">This key works, but its account has no credits. Add credits or a plan in your Comfy account, or use another key.</p>}
        {current?.available != null && (
          <p className={`balance ${current.available <= 0 ? "low" : ""}`}>Balance on your saved key: <b>{money(current.available)}</b></p>
        )}
        {(reason === "need_key" || reason === "manage") && (
          <p className="lead">Open Edit Video runs on Comfy Cloud with your own account. Every model is open source; you only pay Comfy for the GPU time.</p>
        )}

        <ol className="howto">
          <li><b>1</b><span>Open <a href={KEYS_URL} target="_blank" rel="noreferrer" className="url">platform.comfy.org/profile/api-keys ↗</a>, create a new key and copy it. It starts with <code>comfyui-</code>.<small>No account yet? Create one there, it&apos;s free.</small></span></li>
          <li><b>2</b><span>Make sure the account has credits. Each run uses a little GPU time; the estimate shows next to the button.</span></li>
        </ol>

        <label className="keyfield">
          <span>Paste your key</span>
          <span className="row">
            <span className="inputwrap">
              <input id="comfy-key" autoFocus type={show ? "text" : "password"} value={key} onChange={(e) => setKey(e.target.value)} placeholder="comfyui-…"
                autoComplete="off" spellCheck={false} aria-label="Comfy API key" />
              <button type="button" className="paste" title="Paste from clipboard" aria-label="Paste from clipboard" onClick={async () => {
                // Si el navegador no deja leer el portapapeles, se deja el cursor en el campo para pegar con ⌘V / Ctrl+V.
                try { const t = (await navigator.clipboard.readText()).trim(); if (t) { setKey(t); setProblem(null); } }
                catch { document.getElementById("comfy-key")?.focus(); setProblem("Your browser blocked the clipboard. Press ⌘V (Ctrl+V) in the field."); }
              }}>
                <svg viewBox="0 0 24 24" aria-hidden><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9 4.5V3.5a1 1 0 011-1h4a1 1 0 011 1v1" /><path d="M9.5 11h5M9.5 15h5" /></svg>
              </button>
            </span>
            <button type="button" className="ghost" onClick={() => setShow((v) => !v)}>{show ? "Hide" : "Show"}</button>
          </span>
        </label>
        {problem && <p className="alert">{problem}</p>}
        <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember on this device</label>
        <p className="fine">Your key stays in this browser. Our server only uses it to send your jobs to Comfy, and never saves it.</p>

        <div className="actions">
          {hasKey && <button type="button" className="ghost" onClick={() => { saveKey("", false); onSave(""); }}>Remove saved key</button>}
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="go small" disabled={!key.trim() || checking}>{checking ? "Checking…" : reason === "manage" ? "Save key" : "Save and run"}</button>
        </div>
      </form>
    </div>
  );
}
