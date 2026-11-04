import React, { useEffect, useState } from 'react';
import { visualCompanionRepository } from '../../utils/visualCompanion/repository';
import type { CharacterVisualProfile } from '../../utils/visualCompanion/types';

function profileId(charId: string) {
  return 'visual_profile_' + encodeURIComponent(charId);
}

export default function CharacterVisualProfileEditor({ charId, charName }: { charId: string; charName: string }) {
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [profile, setProfile] = useState<CharacterVisualProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    void visualCompanionRepository.getProfile(profileId(charId)).then(current => {
      if (!alive) return;
      setProfile(current);
      // 新版只使用一整段自然语言描述；旧版分项档案在首次打开时自动合并，避免丢失已有设定。
      const legacyDescription = (current?.identity || [])
        .filter(item => item.confirmed && item.value.trim())
        .map(item => item.value.trim())
        .join(', ');
      setDescription([current?.anchorPrompt?.trim(), legacyDescription].filter(Boolean).join(', '));
      setEnabled(current?.status === 'active');
    }).catch(cause => {
      if (alive) setError(cause instanceof Error ? cause.message : '读取人物外貌失败');
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [charId]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const now = Date.now();
      const next: CharacterVisualProfile = {
        id: profileId(charId),
        charId,
        version: (profile?.version || 0) + 1,
        status: enabled ? 'active' : 'draft',
        identity: [],
        anchorPrompt: description.trim(),
        ...(profile?.baseAssetId ? { baseAssetId: profile.baseAssetId } : {}),
        ...(enabled ? { confirmedAt: now } : {}),
        createdAt: profile?.createdAt || now,
        updatedAt: now,
      };
      await visualCompanionRepository.saveProfile(next);
      setProfile(next);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存人物外貌失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section style={{ padding: 16, borderRadius: 22, background: 'linear-gradient(145deg,#f8faff,#eef4ff)', border: '1px solid #dbe7fb', color: '#24334b' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={{ width: 38, height: 38, borderRadius: 13, display: 'grid', placeItems: 'center', background: '#dceafe', color: '#3865a8', fontSize: 20 }}>✧</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 750 }}>固定形象描述</div>
          <div style={{ fontSize: 11, color: '#71819a', marginTop: 3 }}>{charName} · 独立保存，生图时自动参考</div>
        </div>
        <span style={{ fontSize: 10, padding: '5px 8px', borderRadius: 99, background: enabled ? '#d9f5e8' : '#e8edf4', color: enabled ? '#26724e' : '#6c7888' }}>{enabled ? '已启用' : '已停用'}</span>
      </div>
      <p style={{ fontSize: 12, lineHeight: 1.65, color: '#64748b', margin: '8px 0 12px' }}>
        用一整段话描述人物固定的长相和画风即可。建议使用英文，写清脸部、发型、眼睛、体态和辨识特征；服装、动作与场景留给每次生图决定。
      </p>
      {loading ? <div style={{ padding: 24, textAlign: 'center', color: '#8190a6', fontSize: 12 }}>正在读取人物档案…</div> : (
        <>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#50627c', marginBottom: 6 }}>Appearance prompt</span>
            <textarea
              value={description}
              onChange={event => { setDescription(event.target.value); setSaved(false); }}
              placeholder={'A young man with refined features, slightly narrow face, soft black hair, deep gray eyes, natural skin texture, slender build, a small beauty mark beneath the left eye. Keep the same facial identity and elegant anime illustration style across images.'}
              rows={8}
              style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', border: '1px solid #d9e4f3', borderRadius: 13, padding: 12, fontSize: 13, lineHeight: 1.7, background: '#ffffffd9', color: '#26364d', outlineColor: '#7da5df' }}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 13, fontSize: 12, color: '#435775' }}>
            <input type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked); setSaved(false); }} />
            每次生图自动加入这段固定形象描述
          </label>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 14 }}>
            <span style={{ fontSize: 10, color: '#8492a7' }}>{profile ? '已保存 · v' + profile.version : '尚未保存'}{saved ? ' · 保存成功' : ''}</span>
            <button type="button" disabled={saving} onClick={() => void save()} style={{ border: 0, borderRadius: 12, padding: '10px 18px', background: '#416fae', color: '#fff', fontSize: 12, fontWeight: 700, opacity: saving ? 0.65 : 1 }}>
              {saving ? '保存中…' : '保存描述'}
            </button>
          </div>
          {error && <div role="alert" style={{ marginTop: 10, fontSize: 11, color: '#b42318' }}>{error}</div>}
        </>
      )}
    </section>
  );
}
