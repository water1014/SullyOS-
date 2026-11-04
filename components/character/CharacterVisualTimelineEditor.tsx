import React, { useEffect, useState } from 'react';
import { visualCompanionRepository } from '../../utils/visualCompanion/repository';
import type { VisualMemoryRecord } from '../../utils/visualCompanion/types';

export default function CharacterVisualTimelineEditor({ charId }: { charId: string }) {
  const [items, setItems] = useState<VisualMemoryRecord[]>([]);
  const [kind, setKind] = useState<'permanent' | 'temporary'>('temporary');
  const [content, setContent] = useState('');
  const [days, setDays] = useState('1');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    const records = await visualCompanionRepository.listMemories(charId);
    setItems(records.filter(item => item.visualChangeKind === 'permanent' || item.visualChangeKind === 'temporary')
      .sort((a, b) => b.createdAt - a.createdAt));
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void visualCompanionRepository.listMemories(charId)
      .then(records => { if (alive) setItems(records.filter(item => item.visualChangeKind === 'permanent' || item.visualChangeKind === 'temporary').sort((a, b) => b.createdAt - a.createdAt)); })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : '读取外貌时间线失败'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [charId]);

  const add = async () => {
    const text = content.trim();
    if (!text || saving) return;
    setSaving(true); setError('');
    try {
      const now = Date.now();
      const id = 'visual_change_' + (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : now + '_' + Math.random().toString(36).slice(2));
      const activeUntil = kind === 'temporary' ? now + Math.max(1, Number(days) || 1) * 24 * 60 * 60 * 1000 : undefined;
      await visualCompanionRepository.saveMemory({
        id, charId, status: 'confirmed', source: 'user', category: 'appearance_timeline',
        visualChangeKind: kind, ...(activeUntil ? { activeUntil } : {}),
        content: text, locked: false, privacyScope: 'standard', createdAt: now, updatedAt: now, confirmedAt: now,
      });
      setContent('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存外貌变化失败');
    } finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    try { await visualCompanionRepository.deleteMemory(id); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除外貌变化失败'); }
  };

  return <section style={{ marginTop: 14, padding: 16, borderRadius: 22, background: 'linear-gradient(145deg,#f8fbff,#edf4ff)', border: '1px solid #dbe7fb', color: '#24334b' }}>
    <div style={{ fontSize: 15, fontWeight: 750 }}>外貌变化时间线</div>
    <p style={{ fontSize: 11, lineHeight: 1.65, color: '#71819a', margin: '5px 0 12px' }}>把永久变化和临时状态分开记录。永久变化持续参与后续生图；临时状态到期自动退出，不会改写固定形象。</p>
    <div style={{ display: 'flex', gap: 8, marginBottom: 9 }}>
      <select value={kind} onChange={event => setKind(event.target.value as 'permanent' | 'temporary')} style={{ border: '1px solid #d9e4f3', borderRadius: 10, padding: '8px', background: 'white', color: '#334155', fontSize: 12 }}>
        <option value="temporary">临时状态</option><option value="permanent">永久变化</option>
      </select>
      {kind === 'temporary' && <select value={days} onChange={event => setDays(event.target.value)} style={{ border: '1px solid #d9e4f3', borderRadius: 10, padding: '8px', background: 'white', color: '#334155', fontSize: 12 }}>
        <option value="1">1 天</option><option value="3">3 天</option><option value="7">7 天</option><option value="30">30 天</option>
      </select>}
    </div>
    <textarea value={content} onChange={event => setContent(event.target.value)} rows={3} placeholder={kind === 'permanent' ? '例如：右眉新增一道浅疤，之后的形象都保留它。' : '例如：刚淋过雨，黑色长发和衣领微湿，仅用于近期场景。'} style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #d9e4f3', borderRadius: 12, padding: 11, background: '#ffffffd9', color: '#26364d', fontSize: 12, lineHeight: 1.6 }} />
    <button type="button" disabled={!content.trim() || saving} onClick={() => void add()} style={{ marginTop: 8, border: 0, borderRadius: 11, padding: '9px 15px', background: '#416fae', color: 'white', fontSize: 12, fontWeight: 700, opacity: !content.trim() || saving ? .55 : 1 }}>{saving ? '保存中…' : '确认加入时间线'}</button>
    {loading ? <p style={{ fontSize: 11, color: '#8492a7' }}>正在读取时间线…</p> : items.length === 0 ? <p style={{ fontSize: 11, color: '#8492a7', marginTop: 12 }}>还没有变化记录。</p> : <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
      {items.map(item => {
      const expired = item.visualChangeKind === 'temporary' && item.activeUntil !== undefined && item.activeUntil <= Date.now();
      return <div key={item.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: 10, borderRadius: 12, background: expired ? '#f8fafc' : '#ffffffb8', border: '1px solid #e3ebf7' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 750, color: expired ? '#94a3b8' : item.visualChangeKind === 'permanent' ? '#3865a8' : '#71819a' }}>{item.visualChangeKind === 'permanent' ? '永久变化' : expired ? '临时状态 · 已过期' : '临时状态 · 生效中'}{item.activeUntil ? ' · 截止 ' + new Date(item.activeUntil).toLocaleDateString() : ''}</div>
          <div style={{ fontSize: 12, lineHeight: 1.6, marginTop: 3, overflowWrap: 'anywhere' }}>{item.content}</div>
        </div>
        <button type="button" onClick={() => void remove(item.id)} style={{ border: 0, background: 'transparent', color: '#b45353', fontSize: 11, padding: 4 }}>删除</button>
      </div>;
    })}
    </div>}
    {error && <div role="alert" style={{ color: '#b42318', fontSize: 11, marginTop: 8 }}>{error}</div>}
  </section>;
}
