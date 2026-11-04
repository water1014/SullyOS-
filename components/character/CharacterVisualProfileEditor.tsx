import React, { useEffect, useMemo, useState } from 'react';
import { visualCompanionRepository } from '../../utils/visualCompanion/repository';
import type { CharacterVisualProfile } from '../../utils/visualCompanion/types';

const FIELDS = [
  { key: 'face', label: '脸型与五官', placeholder: '例如：偏窄的鹅蛋脸，眉眼清晰，鼻梁挺直' },
  { key: 'hair', label: '发型与发色', placeholder: '例如：黑色长发，微卷，额前有轻薄碎刘海' },
  { key: 'eyes', label: '眼睛与瞳色', placeholder: '例如：灰蓝色眼睛，眼尾略长' },
  { key: 'skin', label: '肤色与质感', placeholder: '例如：自然白皙肤色' },
  { key: 'body', label: '身形与体态', placeholder: '例如：修长身形，肩线平直' },
  { key: 'features', label: '标志性特征', placeholder: '例如：左眼下有一颗小痣' },
  { key: 'style', label: '固定画风', placeholder: '例如：精致日系插画，柔和赛璐璐上色' },
] as const;

type FieldKey = typeof FIELDS[number]['key'];
type FieldValues = Record<FieldKey, string>;

const emptyFields = (): FieldValues => ({
  face: '', hair: '', eyes: '', skin: '', body: '', features: '', style: '',
});

function profileId(charId: string) {
  return 'visual_profile_' + encodeURIComponent(charId);
}

export default function CharacterVisualProfileEditor({ charId, charName }: { charId: string; charName: string }) {
  const [fields, setFields] = useState<FieldValues>(emptyFields);
  const [extraPrompt, setExtraPrompt] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [profile, setProfile] = useState<CharacterVisualProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    void visualCompanionRepository.getProfile(profileId(charId)).then(saved => {
      if (!alive) return;
      setProfile(saved);
      const next = emptyFields();
      for (const item of saved?.identity || []) {
        if (item.key in next) next[item.key as FieldKey] = item.value;
      }
      setFields(next);
      setExtraPrompt(saved?.anchorPrompt || '');
      setEnabled(saved?.status === 'active');
    }).catch(cause => {
      if (alive) setError(cause instanceof Error ? cause.message : '读取人物外貌失败');
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [charId]);

  const completedCount = useMemo(() => FIELDS.filter(field => fields[field.key].trim()).length, [fields]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const now = Date.now();
      const identity = FIELDS
        .filter(field => fields[field.key].trim())
        .map(field => ({
          key: field.key,
          value: fields[field.key].trim(),
          confirmed: true,
          source: 'user' as const,
          locked: true,
          updatedAt: now,
        }));
      const next: CharacterVisualProfile = {
        id: profileId(charId),
        charId,
        version: (profile?.version || 0) + 1,
        status: enabled ? 'active' : 'draft',
        identity,
        anchorPrompt: extraPrompt.trim(),
        ...(profile?.baseAssetId ? { baseAssetId: profile.baseAssetId } : {}),
        ...(enabled ? { confirmedAt: now } : {}),
        createdAt: profile?.createdAt || now,
        updatedAt: now,
      };
      await visualCompanionRepository.saveProfile(next);
      setProfile(next);
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
          <div style={{ fontSize: 16, fontWeight: 750 }}>人物外貌连接</div>
          <div style={{ fontSize: 11, color: '#71819a', marginTop: 3 }}>{charName} · 独立保存的固定形象档案</div>
        </div>
        <span style={{ fontSize: 10, padding: '5px 8px', borderRadius: 99, background: enabled ? '#d9f5e8' : '#e8edf4', color: enabled ? '#26724e' : '#6c7888' }}>{enabled ? '生图自动调用' : '暂不调用'}</span>
      </div>
      <p style={{ fontSize: 12, lineHeight: 1.65, color: '#64748b', margin: '8px 0 14px' }}>
        这里只记录不随场景变化的人物特征。服装、动作、表情和背景仍由每次生图提示词决定，避免固定外貌档案把场景锁死。
      </p>
      {loading ? <div style={{ padding: 24, textAlign: 'center', color: '#8190a6', fontSize: 12 }}>正在读取人物档案…</div> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 10 }}>
            {FIELDS.map(field => (
              <label key={field.key} style={{ display: 'block', minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#50627c', marginBottom: 5 }}>{field.label}</span>
                <textarea
                  value={fields[field.key]}
                  onChange={event => setFields(current => ({ ...current, [field.key]: event.target.value }))}
                  placeholder={field.placeholder}
                  rows={2}
                  style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', border: '1px solid #d9e4f3', borderRadius: 11, padding: 9, fontSize: 12, lineHeight: 1.5, background: '#ffffffd9', color: '#26364d', outlineColor: '#7da5df' }}
                />
              </label>
            ))}
          </div>
          <label style={{ display: 'block', marginTop: 12 }}>
            <span style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#50627c', marginBottom: 5 }}>补充外貌约束 / 统一描述</span>
            <textarea
              value={extraPrompt}
              onChange={event => setExtraPrompt(event.target.value)}
              placeholder="写下其他必须保持一致的外貌细节，例如年龄感、气质、不能改变的辨识特征。"
              rows={3}
              style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', border: '1px solid #d9e4f3', borderRadius: 11, padding: 10, fontSize: 12, lineHeight: 1.6, background: '#ffffffd9', color: '#26364d', outlineColor: '#7da5df' }}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 13, fontSize: 12, color: '#435775' }}>
            <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
            每次生图自动注入这份人物外貌档案
          </label>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 14 }}>
            <span style={{ fontSize: 10, color: '#8492a7' }}>{completedCount}/7 项已填写 · {profile ? '版本 ' + profile.version : '尚未保存'}</span>
            <button type="button" disabled={saving} onClick={() => void save()} style={{ border: 0, borderRadius: 12, padding: '10px 18px', background: '#416fae', color: '#fff', fontSize: 12, fontWeight: 700, opacity: saving ? 0.65 : 1 }}>
              {saving ? '保存中…' : '保存人物档案'}
            </button>
          </div>
          {error && <div role="alert" style={{ marginTop: 10, fontSize: 11, color: '#b42318' }}>{error}</div>}
        </>
      )}
    </section>
  );
}
