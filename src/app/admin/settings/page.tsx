"use client";
import { useCallback, useEffect, useState } from "react";
import { api, dt } from "@/lib/api";

interface Override { id: string; scopeType: string; scopeId: string; scopeName: string; value: unknown }
interface Setting { key: string; value: unknown; type: string; unit: string; description: string; min: number | null; max: number | null; options: string[] | null; updatedAt: string; overrides: Override[] }
interface Change { id: string; key: string; scopeType: string; scopeId: string | null; oldValue: unknown; newValue: unknown; reason: string; changedById: string | null; createdAt: string; revertOfId: string | null }
interface Area { id: string; name: string; shops: { id: string; name: string }[] }

const show = (v: unknown) => (v === null || v === undefined ? "（なし）" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** 入力欄の文字を、設定の型に合わせた値にする */
function parse(type: string, text: string): unknown {
  if (type === "int" || type === "decimal") return text.trim() === "" ? NaN : Number(text);
  if (type === "bool") return text === "true";
  if (type === "json") return JSON.parse(text);
  return text;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [history, setHistory] = useState<Change[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState("global");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const load = useCallback(async () => {
    const [s, h, a] = await Promise.all([api<Setting[]>("/api/admin/settings"), api<Change[]>("/api/admin/settings/history"), api<Area[]>("/api/admin/areas")]);
    setSettings(s); setHistory(h); setAreas(a);
  }, []);
  useEffect(() => { load().catch((e) => setErr(e.message)); }, [load]);

  async function submit(s: Setting) {
    setErr(""); setOk("");
    try {
      let value: unknown;
      try { value = parse(s.type, text); } catch { throw new Error("JSON の書き方が正しくありません"); }
      if (scope === "global") await api(`/api/admin/settings/${s.key}`, { method: "PUT", body: { value, reason } });
      else {
        const [scopeType, scopeId] = scope.split(":");
        await api(`/api/admin/settings/${s.key}/overrides`, { method: "PUT", body: { scopeType, scopeId, value, reason } });
      }
      setOk(`${s.key} を変更しました。これから作られる注文から反映されます（進行中の注文は注文時点の値のまま）。`);
      setEditing(null); setReason("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function revert(c: Change) {
    const r = prompt("元に戻す理由を入力してください");
    if (!r) return;
    setErr(""); setOk("");
    try {
      await api(`/api/admin/settings/history/${c.id}/revert`, { body: { reason: r } });
      setOk(`${c.key} を ${show(c.oldValue)} に戻しました`);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function removeOverride(s: Setting, o: Override) {
    const r = prompt(`${o.scopeName} の上書きをやめる理由`);
    if (!r) return;
    try {
      await api(`/api/admin/settings/${s.key}/overrides/${o.id}`, { method: "DELETE", body: { reason: r } });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <>
      <h1>設定値の管理</h1>
      <p className="muted small">変更は「これから作られる注文」から反映されます。進行中の注文は、注文時点の値（スナップショット）で計算されます。</p>
      {err && <div className="msg error">{err}</div>}
      {ok && <div className="msg info">{ok}</div>}
      {settings.map((s) => (
        <div key={s.key} className="card">
          <div className="between">
            <div>
              <strong className="code">{s.key}</strong>
              <div className="small">{s.description}</div>
              <div className="muted small">型：{s.type}・単位：{s.unit}{s.min != null && `・最小 ${s.min}`}{s.max != null && `・最大 ${s.max}`}{s.options && `・選択肢 ${s.options.join(" / ")}`}</div>
            </div>
            <div className="right"><div className="code">{show(s.value)}</div><button className="secondary small" onClick={() => { setEditing(s.key); setText(show(s.value)); setScope("global"); setErr(""); }}>変える</button></div>
          </div>
          {s.overrides.map((o) => (
            <div key={o.id} className="small row"><span className="badge">{o.scopeType === "shop" ? "店" : "エリア"}：{o.scopeName}</span><span className="code">{show(o.value)}</span><button className="secondary small" onClick={() => removeOverride(s, o)}>上書きをやめる</button></div>
          ))}
          {editing === s.key && (
            <div className="stack" style={{ marginTop: 8 }}>
              <label>どこに適用するか</label>
              <select value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="global">全体</option>
                {areas.map((a) => <option key={a.id} value={`area:${a.id}`}>エリア：{a.name}</option>)}
                {areas.flatMap((a) => a.shops).map((sh) => <option key={sh.id} value={`shop:${sh.id}`}>店：{sh.name}</option>)}
              </select>
              <label>新しい値</label>
              {s.type === "bool" ? (
                <select value={text} onChange={(e) => setText(e.target.value)}><option value="true">はい（true）</option><option value="false">いいえ（false）</option></select>
              ) : s.type === "enum" ? (
                <select value={text} onChange={(e) => setText(e.target.value)}>{s.options?.map((o) => <option key={o}>{o}</option>)}</select>
              ) : s.type === "json" ? (
                <textarea rows={4} className="code" value={text} onChange={(e) => setText(e.target.value)} />
              ) : (
                <input value={text} onChange={(e) => setText(e.target.value)} />
              )}
              <label>変更の理由（必須・記録に残ります）</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="row"><button onClick={() => submit(s)}>保存</button><button className="secondary" onClick={() => setEditing(null)}>やめる</button></div>
            </div>
          )}
        </div>
      ))}
      <h2>変更履歴</h2>
      <div className="card scroll-x">
        <table>
          <thead><tr><th>日時</th><th>キー</th><th>範囲</th><th>前 → 後</th><th>理由</th><th></th></tr></thead>
          <tbody>
            {history.map((c) => (
              <tr key={c.id}>
                <td className="small">{dt(c.createdAt)}</td>
                <td className="code">{c.key}</td>
                <td className="small">{c.scopeType}{c.scopeId ? `:${c.scopeId}` : ""}</td>
                <td className="code">{show(c.oldValue)} → {show(c.newValue)}</td>
                <td className="small">{c.reason}{c.revertOfId && "（差し戻し）"}</td>
                <td>{c.oldValue !== null && <button className="secondary small" onClick={() => revert(c)}>この前の値に戻す</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
